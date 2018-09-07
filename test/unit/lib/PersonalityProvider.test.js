import {GlobalOverrider} from "test/unit/utils";
import injector from "inject!lib/PersonalityProvider.jsm";

const TIME_SEGMENTS = [
  {"id": "hour", "startTime": 3600, "endTime": 0, "weightPosition": 1},
  {"id": "day", "startTime": 86400, "endTime": 3600, "weightPosition": 0.75},
  {"id": "week", "startTime": 604800, "endTime": 86400, "weightPosition": 0.5},
  {"id": "weekPlus", "startTime": null, "endTime": 604800, "weightPosition": 0.25}
];

const PARAMETER_SETS = {
  "paramSet1": {
    "recencyFactor": 0.5,
    "frequencyFactor": 0.5,
    "combinedDomainFactor": 0.5,
    "perfectFrequencyVisits": 10,
    "perfectCombinedDomainScore": 2,
    "multiDomainBoost": 0.1,
    "itemScoreFactor": 0
  },
  "paramSet2": {
    "recencyFactor": 1,
    "frequencyFactor": 0.7,
    "combinedDomainFactor": 0.8,
    "perfectFrequencyVisits": 10,
    "perfectCombinedDomainScore": 2,
    "multiDomainBoost": 0.1,
    "itemScoreFactor": 0
  }
};

describe("Personality Provider", () => {
  let instance;
  let PersonalityProvider;
  let globals;
  let NaiveBayesTextTaggerStub;
  let NmfTextTaggerStub;
  let RecipeExecutorStub;
  let mockHistory;

  beforeEach(() => {
    globals = new GlobalOverrider();

    const testUrl = "www.somedomain.com";
    globals.sandbox.stub(global.Services.io, "newURI").returns({host: testUrl});

    globals.sandbox.stub(global.PlacesUtils.history, "executeQuery").returns({root: {childCount: 1, getChild: index => ({uri: testUrl, accessCount: 1})}});
    globals.sandbox.stub(global.PlacesUtils.history, "getNewQuery").returns({"TIME_RELATIVE_NOW": 1});
    globals.sandbox.stub(global.PlacesUtils.history, "getNewQueryOptions").returns({});

    NaiveBayesTextTaggerStub = globals.sandbox.stub();
    NmfTextTaggerStub = globals.sandbox.stub();
    RecipeExecutorStub = globals.sandbox.stub();

    ({PersonalityProvider} = injector({
      "lib/NaiveBayesTextTagger.jsm": {NaiveBayesTextTagger: NaiveBayesTextTaggerStub},
      "lib/NmfTextTagger.jsm": {NmfTextTagger: NmfTextTaggerStub},
      "lib/RecipeExecutor.jsm": {RecipeExecutor: RecipeExecutorStub}
    }));

    instance = new PersonalityProvider(TIME_SEGMENTS, PARAMETER_SETS);

    mockHistory = [
      {
        title: "automotive",
        description: "something about automotive",
        url: "http://example.com/automotive",
        frecency: 10
      },
      {
        title: "fashion",
        description: "something about fashion",
        url: "http://example.com/fashion",
        frecency: 5
      },
      {
        title: "tech",
        description: "something about tech",
        url: "http://example.com/tech",
        frecency: 1
      }
    ];

    instance.fetchHistory = (a, b, c) => mockHistory;

    instance.interestConfig = {
      history_item_builder: "history_item_builder",
      interest_finalizer: "interest_finalizer",
      item_to_rank_builder: "item_to_rank_builder",
      item_ranker: "item_ranker",
      interest_combiner: "interest_combiner"
    };

    // mock the RecipeExecutor
    instance.recipeExecutor = {
      executeRecipe: (item, recipe) => {
        if (recipe === "history_item_builder") {
          if (item.title === "fail") {
            return null;
          }
          return {title: item.title, score: item.frecency, type: "history_item"};
        } else if (recipe === "interest_finalizer") {
          return {title: item.title, score: item.score * 100, type: "interest_vector"};
        } else if (recipe === "item_to_rank_builder") {
          if (item.title === "fail") {
            return null;
          }
          return {title: item.title, item_score: item.score, type: "item_to_rank"};
        } else if (recipe === "item_ranker") {
          if ((item.tile === "fail") || (item.item_title === "fail")) {
            return null;
          }
          return {title: item.title, score: item.item_score * item.score, type: "ranked_item"};
        }
        return null;
      },
      executeCombinerRecipe: (item1, item2, recipe) => {
        if (recipe === "interest_combiner") {
          if ((item1.title === "combiner_fail") || (item2.title === "combiner_fail")) {
            return null;
          }
          if (item1.type === undefined) {
            item1.type = "combined_iv";
          }
          if (item1.score === undefined) {
            item1.score = 0;
          }
          return {type: item1.type, score: item1.score + item2.score};
        }
        return null;
      }
    };
  });
  afterEach(() => {
    globals.restore();
  });
  describe("#interestVector", () => {
    it("should have an interestVectorStore", () => {
      assert.equal(instance.interestVectorStore.name, "interest-vector");
      // The is to make sure prelaod is set to true.
      assert.equal(!!instance.interestVectorStore._cache, true);
    });
  });
  describe("#models", () => {
    it("should return expected results from getModel", () => {
      try {
        instance.getModel("nothing");
      } catch (e) {
        assert.equal(e.message, "Personality provider received unexpected model for get model: nothing");
      }

      assert.equal(!instance._nmfModelsports, true);
      assert.equal(!instance._nbModelsports, true);

      assert.equal(!!instance.getModel("nmf", "sports").get, true);
      assert.equal(!!instance.getModel("nb", "sports").get, true);

      assert.equal(!!instance._nmfModelsports, true);
      assert.equal(!!instance._nbModelsports, true);
    });
  });
  describe("#taggers", () => {
    it("should throw from generateTagger without model nb or nmf", () => {
      try {
        instance.generateTagger("nothing");
      } catch (e) {
        assert.equal(e.message, "Personality provider received unexpected model for generate tagger: nothing");
      }
    });
    it("should return a nb text tagger from generateTagger nb model", () => {
      sinon.stub(instance, "getModel");

      const tagger = instance.generateTagger("nb", "sports");

      assert.calledOnce(NaiveBayesTextTaggerStub);
      assert.calledOnce(instance.getModel);
      assert.notCalled(NmfTextTaggerStub);
      assert.calledWith(instance.getModel, "nb", "sports");
      assert.isDefined(tagger);
    });
    it("should return a nmf text tagger from generateTagger nmf model", () => {
      sinon.stub(instance, "getModel");

      const tagger = instance.generateTagger("nmf", "sports");

      assert.calledOnce(NmfTextTaggerStub);
      assert.calledOnce(instance.getModel);
      assert.notCalled(NaiveBayesTextTaggerStub);
      assert.calledWith(instance.getModel, "nmf", "sports");
      assert.isDefined(tagger);
    });
  });
  describe("#recipe", () => {
    it("should get and fetch a new recipe on first getRecipe", () => {
      sinon.stub(instance, "getRemoteSettings");
      instance.getRecipe();
      assert.calledOnce(instance.getRemoteSettings);
      assert.calledWith(instance.getRemoteSettings, "personality-provider-recipe");
    });
    it("should not fetch a recipe on getRecipe if cached", () => {
      sinon.stub(instance, "getRemoteSettings");
      instance.recipe = {};
      instance.getRecipe();
      assert.notCalled(instance.getRemoteSettings);
    });
    it("should generate two taggers and a recipe executor when calling generateRecipeExecutor", () => {
      sinon.stub(instance, "generateTagger");
      instance.generateRecipeExecutor("sports");
      assert.calledOnce(RecipeExecutorStub);
      assert.calledTwice(instance.generateTagger);
      const firstCallArgs = instance.generateTagger.firstCall.args;
      const secondCallArgs = instance.generateTagger.secondCall.args;
      assert.equal(firstCallArgs[0], "nb");
      assert.equal(firstCallArgs[1], "sports");
      assert.equal(secondCallArgs[0], "nmf");
      assert.equal(secondCallArgs[1], "sports");
    });
  });
  describe("#createInterestVector", () => {
    it("should gracefully handle history entries that fail", () => {
      mockHistory.push({title: "fail"});
      assert.isTrue(instance.createInterestVector() !== null);
    });

    it("should fail if the combiner fails", () => {
      mockHistory.push({title: "combiner_fail", frecency: 111});
      let actual = instance.createInterestVector();
      assert.isTrue(actual === null);
    });

    it("should process history, combine, and finalize", () => {
      let actual = instance.createInterestVector();
      assert.equal(actual.score, 1600);
    });
  });
  describe("#calculateItemRelevanceScore", () => {
    it("it should return -1 for busted item", () => {
      assert.equal(instance.calculateItemRelevanceScore({title: "fail"}), -1);
    });
    it("it should return a score, and not change with interestVector", () => {
      instance.interestVector = {score: 10};
      assert.equal(instance.calculateItemRelevanceScore({score: 2}), 20);
      assert.deepEqual(instance.interestVector, {score: 10});
    });
  });
});
