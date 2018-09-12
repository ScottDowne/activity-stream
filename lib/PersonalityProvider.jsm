/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const {PersistentCache} = ChromeUtils.import("resource://activity-stream/lib/PersistentCache.jsm", {});
const {RemoteSettings} = ChromeUtils.import("resource://services-settings/remote-settings.js", {});

const {NaiveBayesTextTagger} = ChromeUtils.import("resource://activity-stream/lib/NaiveBayesTextTagger.jsm", {});
const {NmfTextTagger} = ChromeUtils.import("resource://activity-stream/lib/NmfTextTagger.jsm", {});
const {RecipeExecutor} = ChromeUtils.import("resource://activity-stream/lib/RecipeExecutor.jsm", {});

ChromeUtils.defineModuleGetter(this, "NewTabUtils",
  "resource://gre/modules/NewTabUtils.jsm");

/**
 * V2 provider builds and ranks an interest profile (also called an “interest vector”) off the browse history.
 * This allows Firefox to classify pages into topics, by examining the text found on the page.
 * It does this by looking at the history text content, title, and description.
 */
this.PersonalityProvider = class PersonalityProvider {
  constructor(
    timeSegments,
    parameterSets,
    maxHistoryQueryResults,
    version,
    scores,
    modelKeys = []) {
    this.modelKeys = modelKeys;
    this.timeSegments = timeSegments;
    this.maxHistoryQueryResults = maxHistoryQueryResults;
    this.version = version;
    this.interestVectorStore = new PersistentCache("interest-vector", true);
    this.init();
  }

  async init() {
    // TODO: Probably need to use and check cache for these better.
    // Either these functions know to check for cache and use it,
    // or we can pass it from the feed through this constructor.
    this.interestConfig = await this.getRecipe();
    this.recipeExecutor = this.generateRecipeExecutor();
    this.interestVector = await this.createInterestVector();
    this.initialized = true;
  }

  getRemoteSettings(name) {
    return RemoteSettings(name).get();
  }

  getRecipeExecutor(nbTaggers, nmfTaggers) {
    return new RecipeExecutor(nbTaggers, nmfTaggers);
  }

  getNaiveBayesTextTagger(model) {
    return new NaiveBayesTextTagger(model);
  }

  getNmfTextTagger(model) {
    return new NmfTextTagger(model);
  }

  /**
   * Returns a Recipe from remote settings to be consumed by a RecipeExecutor.
   * A Recipe is a set of instructions on how to processes a RecipeExecutor.
   */
  async getRecipe() {
    if (!this.recipe) {
      this.recipe = await this.getRemoteSettings("personality-provider-recipe");
    }
    console.log("this.recipe", this.recipe);
    return this.recipe[0];
  }

  /**
   * Returns a Recipe Executor.
   * A Recipe Executor is a set of actions that can be consumed by a Recipe.
   * The Recipe determines the order and specifics of which the actions are called.
   */
  generateRecipeExecutor() {
    let nbTaggers = [];
    let nmfTaggers = {};
    for (let key of this.modelKeys) {
      let model = this.getRemoteSettings(key);
      if (model.model_type === "nb") {
        nbTaggers.push(this.getNaiveBayesTextTagger(model));
      } else if (model.model_type === "nmf") {
        nmfTaggers[model.parent_tag] = this.getNmfTextTagger(model);
      }
    }
    return this.getRecipeExecutor(nbTaggers, nmfTaggers);
  }

  /**
   * Grabs a slice of browse history for building a interest vector
   */
  async fetchHistory(columns, beginTimeSecs, endTimeSecs) {
    let sql = `SELECT *
    FROM moz_places
    WHERE last_visit_date >= ${beginTimeSecs * 1000000}
    AND last_visit_date < ${endTimeSecs * 1000000}`;
    columns.forEach(requiredColumn => {
      sql += ` AND ${requiredColumn} <> ""`;
    });

    const history = await NewTabUtils.activityStreamProvider.executePlacesQuery(sql, {
      columns,
      params: {}
    });

    return history;
  }

  /**
   * Examines the user's browse history and returns an interest vector that
   * describes the topics the user frequently browses.
   */
  async createInterestVector() {
    console.log("createInterestVector");
    let interestVector = {};
    let endTimeSecs = ((new Date()).getTime() / 1000);
    console.log("..... interestConfig", this.interestConfig);
    let beginTimeSecs = endTimeSecs - this.interestConfig.history_limit_secs;
    let history = await this.fetchHistory(this.interestConfig.history_required_fields, beginTimeSecs, endTimeSecs);

    let itemId = -1;
    for (let historyRec of history) {
      itemId++;
      let ivItem = this.recipeExecutor.executeRecipe(historyRec, this.interestConfig.history_item_builder);
      if (ivItem === null) {
        continue;
      }
      if (Object.keys(ivItem.tags).length > 0) {
        console.log("***** TAGGED ", itemId, " :: ", ivItem);
      }
      interestVector = this.recipeExecutor.executeCombinerRecipe(
        interestVector,
        ivItem,
        this.interestConfig.interest_combiner);
      if (interestVector === null) {
        return null;
      }
    }

    let xxx =  this.recipeExecutor.executeRecipe(interestVector, this.interestConfig.interest_finalizer);
    console.log("FINAL IV ", xxx);
    return xxx;
  }

  /**
   * Calculates a score of a Pocket item when compared to the user's interest
   * vector. Returns the score. Higher scores are better. Assumes this.interestVector
   * is populated.
   */
  calculateItemRelevanceScore(pocketItem) {
    let scorableItem = this.recipeExecutor.executeRecipe(pocketItem, this.interestConfig.item_to_rank_builder);
    if (scorableItem === null) {
      return -1;
    }
    let rankingVector = JSON.parse(JSON.stringify(this.interestVector));
    Object.keys(scorableItem).forEach(key => {
      rankingVector[key] = scorableItem[key];
    });
    rankingVector = this.recipeExecutor.executeRecipe(rankingVector, this.interestConfig.item_ranker);

    if (rankingVector === null) {
      return -1;
    }
    return rankingVector.score;
  }

  /**
   * Returns an object holding the settings and affinity scores of this provider instance.
   */
  getAffinities() {
    return {
      timeSegments: this.timeSegments,
      parameterSets: this.parameterSets,
      maxHistoryQueryResults: this.maxHistoryQueryResults,
      version: this.version,
      scores: this.scores
    };
  }
};

const EXPORTED_SYMBOLS = ["PersonalityProvider"];
