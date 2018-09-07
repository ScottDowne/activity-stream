/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const {UserDomainAffinityProvider} = ChromeUtils.import("resource://activity-stream/lib/UserDomainAffinityProvider.jsm", {});
const {PersistentCache} = ChromeUtils.import("resource://activity-stream/lib/PersistentCache.jsm", {});
const {RemoteSettings} = ChromeUtils.import("resource://services-settings/remote-settings.js", {});

const {NaiveBayesTextTagger} = ChromeUtils.import("resource://activity-stream/lib/NaiveBayesTextTagger.jsm", {});
const {NmfTextTagger} = ChromeUtils.import("resource://activity-stream/lib/NmfTextTagger.jsm", {});
const {TfIdfVectorizer} = ChromeUtils.import("resource://activity-stream/lib/TfIdfVectorizer.jsm", {});
const {RecipeExecutor} = ChromeUtils.import("resource://activity-stream/lib/RecipeExecutor.jsm", {});

ChromeUtils.defineModuleGetter(this, "NewTabUtils",
  "resource://gre/modules/NewTabUtils.jsm");

/**
 * V2 provider builds and ranks an interest profile (also called an “interest vector”) off the browse history.
 * This allows Firefox to classify pages into topics, by examining the text found on the page.
 * It does this by looking at the history text content, title, and description.
 */
this.PersonalityProvider = class PersonalityProvider extends UserDomainAffinityProvider {
  // This is just a stub for now, extending UserDomainAffinityProvider until we flesh it out.
  constructor(...args) {
    super(...args);
    this.interestVectorStore = new PersistentCache("interest-vector", true);
  }

  /**
   * Returns the nb or nmf collection from Remote Settings.
   */
  getModel(modelType, tag) {
    if (modelType !== "nb" && modelType !== "nmf") {
      throw new Error(`Personality provider received unexpected model for get model: ${modelType}`);
    }

    // Do we need to clear this at some point in case we have updates?
    if (!this[`_${modelType}Model${tag}`]) {
      this[`_${modelType}Model${tag}`] = this.getRemoteSettings(`${modelType}-model-${tag}`);
    }
    return this[`_${modelType}Model${tag}`];
  }

  getRemoteSettings(name) {
    return RemoteSettings(name);
  }

  /**
   * Returns a Recipe from remote settings to be consumed by a RecipeExecutor.
   * A Recipe is a set of instructions on how to processes a RecipeExecutor.
   */
  getRecipe() {
    if (!this.recipe) {
      this.recipe = this.getRemoteSettings("personality-provider-recipe");
    }
    return this.recipe;
  }

  /**
   * Returns a Text Tagger from a model type, either nb or nmf.
   * A text tagger allows us to classify text, title or description
   * of pages found in the browser history.
   */
  generateTagger(modelType, tag) {
    if (modelType !== "nb" && modelType !== "nmf") {
      throw new Error(`Personality provider received unexpected model for generate tagger: ${modelType}`);
    }

    let textTagger;

    if (modelType === "nb") {
      textTagger = new NaiveBayesTextTagger(this.getModel("nb", tag), new TfIdfVectorizer());
    } else if (modelType === "nmf") {
      textTagger = new NmfTextTagger(this.getModel("nmf", tag), new TfIdfVectorizer());
    }
    return textTagger;
  }

  /**
   * Returns a Recipe Executor from a model type, either nb or nmf.
   * A Recipe Executor is a set of actions that can be consumed by a Recipe.
   * The Recipe determines the order and specifics of which the actions are called.
   */
  generateRecipeExecutor(tag) {
    return RecipeExecutor(this.generateTagger("nb", tag), this.generateTagger("nmf", tag));
  }

  /**
   * Grabs a slice of browse history for building a interest vector
   */
  async fetchHistory(columns, beginTimeSecs, endTimeSecs) {
    let sql = `SELECT *
    FROM moz_places
    WHERE last_visit_data >= ${beginTimeSecs * 1000000}
    AND last_visit_data < ${endTimeSecs * 1000000}`;
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
  createInterestVector() {
    let interestVector = {};
    let endTimeSecs = ((new Date()).getTime() / 1000);
    let beginTimeSecs = endTimeSecs - this.interestConfig.history_limit_secs;
    let history = this.fetchHistory(this.interestConfig.history_required_fields, beginTimeSecs, endTimeSecs);
    for (let historyRec of history) {
      let ivItem = this.recipeExecutor.executeRecipe(historyRec, this.interestConfig.history_item_builder);
      if (ivItem === null) {
        continue;
      }
      interestVector = this.recipeExecutor.executeCombinerRecipe(
        interestVector,
        ivItem,
        this.interestConfig.interest_combiner);
      if (interestVector === null) {
        return null;
      }
    }

    return this.recipeExecutor.executeRecipe(interestVector, this.interestConfig.interest_finalizer);
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
};

const EXPORTED_SYMBOLS = ["PersonalityProvider"];
