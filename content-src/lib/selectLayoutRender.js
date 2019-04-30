export const selectLayoutRender = (state, prefs, rickRollCache) => {
  const {layout, feeds, spocs} = state;
  let spocIndex = 0;
  let bufferRollCache = [];

  // rickRollCache stores random probability values for each spoc position. This cache is empty
  // on page refresh and gets filled with random values on first render inside maybeInjectSpocs.
  const isFirstRun = !rickRollCache.length;

  function rollForSpocs(data, spocsConfig) {
    const recommendations = [...data.recommendations];
    for (let position of spocsConfig.positions) {
      // Cache random number for a position
      let rickRoll;
      if (isFirstRun) {
        rickRoll = Math.random();
        rickRollCache.push(rickRoll);
      } else {
        rickRoll = rickRollCache.shift();
        bufferRollCache.push(rickRoll);
      }

      if (spocs.data.spocs[spocIndex] && rickRoll <= spocsConfig.probability) {
        recommendations.splice(position.index, 0, spocs.data.spocs[spocIndex++]);
      }
    }

    return {
      ...data,
      recommendations,
    };
  }

  function maybeInjectSpocs(data, spocsConfig) {
    // Do we ever expect to possibly have a spoc.
    if (data && spocsConfig && spocsConfig.positions && spocsConfig.positions.length) {
      // We expect a spoc, and spocs are done loading.
      if (spocs.loaded) {
        // We expect a spoc, spocs are loaded, but the server returned no spocs.
        if (!spocs.data.spocs || !spocs.data.spocs.length) {
          return data;
        }

        // We expect a spoc, spocs are loaded, and we have spocs available.
        return rollForSpocs(data, spocsConfig);
      }

      // We expected a spoc, but non are loaded yet.
      return data;
    }

    return data;
  }

  const positions = {};
  const DS_COMPONENTS = ["Message", "SectionTitle", "Navigation",
    "CardGrid", "Hero", "HorizontalRule", "List"];

  const filterArray = [];

  if (!prefs["feeds.topsites"]) {
    filterArray.push("TopSites");
  }

  if (!prefs["feeds.section.topstories"]) {
    filterArray.push(...DS_COMPONENTS);
  }

  const handleComponent = component => {
    positions[component.type] = positions[component.type] || 0;

    let {data} = feeds.data[component.feed.url];

    if (component && component.properties && component.properties.offset) {
      data = {
        ...data,
        recommendations: data.recommendations.slice(component.properties.offset),
      };
    }

    data = maybeInjectSpocs(data, component.spocs);

    // If empty, fill rickRollCache with random probability values from bufferRollCache
    if (!rickRollCache.length) {
      rickRollCache.push(...bufferRollCache);
    }

    let items = 0;
    if (component.properties && component.properties.items) {
      items = Math.min(component.properties.items, data.recommendations.length);
    }

    // loop through a component items
    // Store the items position sequentially for multiple components of the same type.
    // Example: A second card grid starts pos offset from the last card grid.
    for (let i = 0; i < items; i++) {
      data.recommendations[i].pos = positions[component.type]++;
    }

    return {...component, data};
  };

  const renderLayout = () => {
    const renderedLayout = [];
    for (const row of layout.filter(r => r.components.length)) {
      let components = [];
      renderedLayout.push({
        ...row,
        components,
      });
      for (const component of row.components.filter(c => !filterArray.includes(c.type))) {
        if (component.feed) {
          const spocsConfig = component.spocs;
          // Are we still waiting on a feed/spocs, render what we have, and bail out early.
          if (!feeds.data[component.feed.url] ||
            (spocsConfig && spocsConfig.positions && spocsConfig.positions.length && !spocs.loaded)) {
            return renderedLayout;
          }
          components.push(handleComponent(component));
        } else {
          components.push(component);
        }
      }
    }
    return renderedLayout;
  };

  return renderLayout();
};
