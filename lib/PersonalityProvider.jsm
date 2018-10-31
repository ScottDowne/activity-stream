/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const {RemoteSettings} = ChromeUtils.import("resource://services-settings/remote-settings.js", {});

const {actionCreators: ac} = ChromeUtils.import("resource://activity-stream/common/Actions.jsm", {});
ChromeUtils.defineModuleGetter(this, "perfService", "resource://activity-stream/common/PerfService.jsm");

const {NaiveBayesTextTagger} = ChromeUtils.import("resource://activity-stream/lib/NaiveBayesTextTagger.jsm", {});
const {NmfTextTagger} = ChromeUtils.import("resource://activity-stream/lib/NmfTextTagger.jsm", {});
const {RecipeExecutor} = ChromeUtils.import("resource://activity-stream/lib/RecipeExecutor.jsm", {});

ChromeUtils.defineModuleGetter(this, "NewTabUtils",
  "resource://gre/modules/NewTabUtils.jsm");

ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
ChromeUtils.defineModuleGetter(this, "OS", "resource://gre/modules/osfile.jsm");
XPCOMUtils.defineLazyGlobalGetters(this, ["fetch"]);

XPCOMUtils.defineLazyGetter(this, "gTextDecoder", () => new TextDecoder());

// This doesn't work currently, the fetch wasn't returning the expected
// data structure from https://kinto.dev.mozaws.net/v1/, failing on
// capabilities not being defined.

XPCOMUtils.defineLazyGetter(this, "baseAttachmentsURL", async () => {
  const server = Services.prefs.getCharPref("services.settings.server");
  const serverInfo = await (await fetch(`${server}/`)).json();
  const {capabilities: {attachments: {base_url}}} = serverInfo;
  return base_url;
});

const PERSONALITY_PROVIDER_DIR_NAME = "personality-provider";
const RECIPE_NAME = "personality-provider-recipe-attachment";
const MODELS_NAME = "personality-provider-models-attachment";

function getHash(aStr) {
  // return the two-digit hexadecimal code for a byte
  let toHexString = charCode => ("0" + charCode.toString(16)).slice(-2);

  let hasher = Cc["@mozilla.org/security/hash;1"].
               createInstance(Ci.nsICryptoHash);
  hasher.init(Ci.nsICryptoHash.MD5);
  let stringStream = Cc["@mozilla.org/io/string-input-stream;1"].
                     createInstance(Ci.nsIStringInputStream);
  stringStream.data = aStr;
  hasher.updateFromStream(stringStream, -1);

  // convert the binary hash data to a hex string.
  let binary = hasher.finish(false);
  return Array.from(binary, (c, i) => toHexString(binary.charCodeAt(i))).join("").toLowerCase();
}

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
    v2Params) {
    this.v2Params = v2Params || {};
    this.dispatch = this.v2Params.dispatch || (() => {});
    this.modelKeys = this.v2Params.modelKeys;
    this.timeSegments = timeSegments;
    this.parameterSets = parameterSets;
    this.maxHistoryQueryResults = maxHistoryQueryResults;
    this.version = version;
    this.scores = scores || {};
    this.interestConfig = this.scores.interestConfig;
    this.interestVector = this.scores.interestVector;
    this.setupSyncAttachment(RECIPE_NAME);
    this.setupSyncAttachment(MODELS_NAME);
  }

  setupSyncAttachment(collection) {
    RemoteSettings(collection).on("sync", async event => {
      const {
        data: {created, updated, deleted},
      } = event;

      // Remove every removed attachment.
      const toRemove = deleted.concat(updated.map(u => u.old));
      await Promise.all(toRemove.map(record => this.deleteAttachment(record)));

      // Download every new/updated attachment.
      const toDownload = created.concat(updated.map(u => u.new));
      await Promise.all(toDownload.map(record => this.downloadAttachment(record)));
    });
  }

  async downloadAttachment(record) {
    const {attachment: {location, filename}} = record;
    const headers = new Headers();
    headers.set("Accept-Encoding", "gzip");
    const filepath = (await baseAttachmentsURL) + location;
    const resp = await fetch(filepath, {headers});
    if (!resp.ok) {
      Cu.reportError(`Failed to fetch ${filepath}: ${resp.status}`);
      return;
    }
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    console.log(bytes);
    await OS.File.makeDir(OS.Path.join(OS.Constants.Path.localProfileDir, PERSONALITY_PROVIDER_DIR_NAME));
    const path = OS.Path.join(OS.Constants.Path.localProfileDir, PERSONALITY_PROVIDER_DIR_NAME, filename);
    return OS.File.writeAtomic(path, bytes, {tmpPath: `${path}.tmp`});
  }

  async deleteAttachment(record) {
    const {attachment: {filename}} = record;
    await OS.File.makeDir(OS.Path.join(OS.Constants.Path.localProfileDir, PERSONALITY_PROVIDER_DIR_NAME));
    const path = OS.Path.join(OS.Constants.Path.localProfileDir, PERSONALITY_PROVIDER_DIR_NAME, filename);

    await OS.File.remove(path, {ignoreAbsent: true});
    return OS.File.removeEmptyDir(OS.Path.join(OS.Constants.Path.localProfileDir, PERSONALITY_PROVIDER_DIR_NAME), { ignoreAbsent: true });
  }

  async getAttachment(record) {
/*
      // Figure out hash + md5sum check.
      // const {attachment: {filename, size}} = record;
      // Figure out hash + md5sum check.
      const {attachment: {filename, hash, size}} = record;

      if (!await OS.File.exists(filepath) || await OS.File.stat(filepath).size !== size) {
        await this.downloadAttachment(record);
      } else {
        attachment = await this.getAttachment(record);
        if () {
          await this.downloadAttachment(record);
          attachment = await this.getAttachment(record);
        }
      }
      attachment = attachment || await this.getAttachment(record);
      console.log(attachment);
      console.log(getHash(JSON.stringify(attachment)), hash);
      console.log(getHash(JSON.stringify(attachment)) === hash);
      //if (!await ) {
      //  await this.downloadAttachment(record);
      //}
*/
    const {attachment: {filename, hash, size}} = record;
    const filepath = OS.Path.join(OS.Constants.Path.localProfileDir, PERSONALITY_PROVIDER_DIR_NAME, filename);

    if (!await OS.File.exists(filepath) || await OS.File.stat(filepath).size !== size) {
      await this.downloadAttachment(record);
    }





    //const {attachment: {filename}} = record;
    await OS.File.makeDir(OS.Path.join(OS.Constants.Path.localProfileDir, PERSONALITY_PROVIDER_DIR_NAME));
    try {
      const fileExists = await OS.File.exists(filepath);
      if (fileExists) {
        const binaryData = await OS.File.read(filepath);
        const json = gTextDecoder.decode(binaryData);
        return JSON.parse(json);
      }
    } catch (error) {
      Cu.reportError(`Failed to load ${filepath}: ${error.message}`);
    }
    return {};
  }

  async init(callback) {
    const perfStart = perfService.absNow();
    this.interestConfig = this.interestConfig || await this.getRecipe();
    if (!this.interestConfig) {
      this.dispatch(ac.PerfEvent({event: "PERSONALIZATION_V2_GET_RECIPE_ERROR"}));
      return;
    }
    this.recipeExecutor = await this.generateRecipeExecutor();
    if (!this.recipeExecutor) {
      this.dispatch(ac.PerfEvent({event: "PERSONALIZATION_V2_GENERATE_RECIPE_EXECUTOR_ERROR"}));
      return;
    }
    this.interestVector = this.interestVector || await this.createInterestVector();
    if (!this.interestVector) {
      this.dispatch(ac.PerfEvent({event: "PERSONALIZATION_V2_CREATE_INTEREST_VECTOR_ERROR"}));
      return;
    }

    this.dispatch(ac.PerfEvent({
      event: "PERSONALIZATION_V2_TOTAL_DURATION",
      value: Math.round(perfService.absNow() - perfStart),
    }));

    this.initialized = true;
    if (callback) {
      callback();
    }
  }

  async getFromRemoteSettings(name) {
    const result = await RemoteSettings(name).get();
    return Promise.all(result.map(async record => {
      const {attachment: {filename}} = record;
      await OS.File.makeDir(OS.Path.join(OS.Constants.Path.localProfileDir, PERSONALITY_PROVIDER_DIR_NAME));
      const filepath = OS.Path.join(OS.Constants.Path.localProfileDir, PERSONALITY_PROVIDER_DIR_NAME, filename);
      return {...await this.getAttachment(record), recordKey: record.key};
    }));
  }

  /**
   * Returns a Recipe from remote settings to be consumed by a RecipeExecutor.
   * A Recipe is a set of instructions on how to processes a RecipeExecutor.
   */
  async getRecipe() {
    if (!this.recipes || !this.recipes.length) {
      const start = perfService.absNow();
      this.recipes = await this.getFromRemoteSettings(RECIPE_NAME);
      this.dispatch(ac.PerfEvent({
        event: "PERSONALIZATION_V2_GET_RECIPE_DURATION",
        value: Math.round(perfService.absNow() - start),
      }));
    }
    return this.recipes[0];
  }

  /**
   * Returns a Recipe Executor.
   * A Recipe Executor is a set of actions that can be consumed by a Recipe.
   * The Recipe determines the order and specifics of which the actions are called.
   */
  async generateRecipeExecutor() {
    if (!this.taggers) {
      const startTaggers = perfService.absNow();
      let nbTaggers = [];
      let nmfTaggers = {};
      const models = await this.getFromRemoteSettings(MODELS_NAME);

      if (models.length === 0) {
        return null;
      }

      for (let model of models) {
        if (!this.modelKeys.includes(model.recordKey)) {
          continue;
        }
        if (model.model_type === "nb") {
          nbTaggers.push(new NaiveBayesTextTagger(model));
        } else if (model.model_type === "nmf") {
          nmfTaggers[model.parent_tag] = new NmfTextTagger(model);
        }
      }
      this.dispatch(ac.PerfEvent({
        event: "PERSONALIZATION_V2_TAGGERS_DURATION",
        value: Math.round(perfService.absNow() - startTaggers),
      }));
      this.taggers = {nbTaggers, nmfTaggers};
    }
    const startRecipeExecutor = perfService.absNow();
    const recipeExecutor = new RecipeExecutor(this.taggers.nbTaggers, this.taggers.nmfTaggers);
    this.dispatch(ac.PerfEvent({
      event: "PERSONALIZATION_V2_RECIPE_EXECUTOR_DURATION",
      value: Math.round(perfService.absNow() - startRecipeExecutor),
    }));
    return recipeExecutor;
  }

  /**
   * Grabs a slice of browse history for building a interest vector
   */
  async fetchHistory(columns, beginTimeSecs, endTimeSecs) {
    let sql = `SELECT url, title, visit_count, frecency, last_visit_date, description
    FROM moz_places
    WHERE last_visit_date >= ${beginTimeSecs * 1000000}
    AND last_visit_date < ${endTimeSecs * 1000000}`;
    columns.forEach(requiredColumn => {
      sql += ` AND IFNULL(${requiredColumn}, "") <> ""`;
    });
    sql += " LIMIT 30000";

    const {activityStreamProvider} = NewTabUtils;
    const history = await activityStreamProvider.executePlacesQuery(sql, {
      columns,
      params: {},
    });

    return history;
  }

  /**
   * Examines the user's browse history and returns an interest vector that
   * describes the topics the user frequently browses.
   */
  async createInterestVector() {
    let interestVector = {};
    let endTimeSecs = ((new Date()).getTime() / 1000);
    let beginTimeSecs = endTimeSecs - this.interestConfig.history_limit_secs;
    let history = await this.fetchHistory(this.interestConfig.history_required_fields, beginTimeSecs, endTimeSecs);

    this.dispatch(ac.PerfEvent({
      event: "PERSONALIZATION_V2_HISTORY_SIZE",
      value: history.length,
    }));

    const start = perfService.absNow();
    for (let historyRec of history) {
      let ivItem = this.recipeExecutor.executeRecipe(
        historyRec,
        this.interestConfig.history_item_builder);
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

    const finalResult = this.recipeExecutor.executeRecipe(
      interestVector,
      this.interestConfig.interest_finalizer);

    this.dispatch(ac.PerfEvent({
      event: "PERSONALIZATION_V2_CREATE_INTEREST_VECTOR_DURATION",
      value: Math.round(perfService.absNow() - start),
    }));
    return finalResult;
  }

  /**
   * Calculates a score of a Pocket item when compared to the user's interest
   * vector. Returns the score. Higher scores are better. Assumes this.interestVector
   * is populated.
   */
  calculateItemRelevanceScore(pocketItem) {
    if (!this.initialized) {
      return pocketItem.item_score || 1;
    }
    let scorableItem = this.recipeExecutor.executeRecipe(
      pocketItem,
      this.interestConfig.item_to_rank_builder);
    if (scorableItem === null) {
      return -1;
    }

    let rankingVector = JSON.parse(JSON.stringify(this.interestVector));

    Object.keys(scorableItem).forEach(key => {
      rankingVector[key] = scorableItem[key];
    });

    rankingVector = this.recipeExecutor.executeRecipe(
      rankingVector,
      this.interestConfig.item_ranker);

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
      scores: {
        interestConfig: this.interestConfig,
        interestVector: this.interestVector,
        taggers: this.taggers,
      },
    };
  }
};

const EXPORTED_SYMBOLS = ["PersonalityProvider"];
