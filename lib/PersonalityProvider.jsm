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

/**
 * V2 provider builds and ranks an interest profile (also called an “interest vector”) off the browse history.
 * This allows Firefox to classify pages into topics, by examining the text found on the page.
 * It does this by looking at the history text content, title, and description.
 */
this.PersonalityProvider = class PersonalityProvider extends UserDomainAffinityProvider {
  // This is just a stub for now, extending UserDomainAffinityProvider until we flesh it out.
  constructor(
    timeSegments,
    parameterSets,
    maxHistoryQueryResults,
    version,
    scores,
    modelKeys) {
    super(
      timeSegments,
      parameterSets,
      maxHistoryQueryResults,
      version,
      scores);
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
};

const EXPORTED_SYMBOLS = ["PersonalityProvider"];
