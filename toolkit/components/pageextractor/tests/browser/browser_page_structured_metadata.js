/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { StructuredMetadataReader } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/pageextractor/StructuredMetadataReader.sys.mjs"
);

const EMPTY_METADATA = {
  truncated: false,
  url: null,
  title: "",
  canonicalUrl: null,
  language: null,
  metaTags: [],
  jsonLd: [],
};

add_task(async function test_structured_metadata_reader_mode() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <meta name="description" content="Original description" />
    <article>
      <h1>Structured metadata in reader mode</h1>
      <p>
        ${"Reader mode presents an article without the original page metadata. ".repeat(
          100
        )}
      </p>
    </article>
  `;
  try {
    Assert.deepEqual(
      (await getPageExtractor().getStructuredMetadata()).metaTags,
      [{ name: "description", value: "Original description" }],
      "The original page exposes its metadata."
    );
    await toggleReaderMode();
    Assert.deepEqual(
      await getPageExtractor().getStructuredMetadata(),
      EMPTY_METADATA,
      "Reader mode does not expose metadata from the replaced page."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_structured_metadata_headless() {
  const { PageExtractorParent } = ChromeUtils.importESModule(
    "resource://gre/actors/PageExtractorParent.sys.mjs"
  );
  const page = MLTestUtils.serveHTML().html`
    <meta name="description" content="Headless description" />
    <script type="application/ld+json">{ "@type": "Recipe" }</script>
    <p>Headless page.</p>
  `;
  try {
    const result = await PageExtractorParent.getHeadlessExtractor({
      urlString: page.url,
      callback: (actor, traceId) => actor.getStructuredMetadata(traceId),
    });
    Assert.deepEqual(result, {
      truncated: false,
      url: page.url,
      title: "",
      canonicalUrl: null,
      language: null,
      metaTags: [{ name: "description", value: "Headless description" }],
      jsonLd: ['{"@type":"Recipe"}'],
    });
  } finally {
    await page.cleanup();
  }
});

add_task(async function test_meta_tags_keep_order_and_conflicts() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <meta name="viewport" content="width=device-width" />
    <meta name="csrf-token" content="secret-token" />
    <meta name="description" content="HTML description" />
    <meta name="Keywords" content="soup, winter" />
    <meta property="og:description" content="Open Graph description" />
    <meta property="og:image" content="https://example.com/first.jpg" />
    <meta property="og:image" content="https://example.com/second.jpg" />
    <meta property="article:published_time" content="2026-10-05" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta property="twitter:description" content="Twitter description" />
    <meta property="og:title" content="" />
    <meta property="og:site_name" name="twitter:site" content="@example" />
    <p>Soup.</p>
  `;
  try {
    Assert.deepEqual(
      (await getPageExtractor().getStructuredMetadata()).metaTags,
      [
        { name: "description", value: "HTML description" },
        { name: "keywords", value: "soup, winter" },
        { name: "og:description", value: "Open Graph description" },
        { name: "og:image", value: "https://example.com/first.jpg" },
        { name: "og:image", value: "https://example.com/second.jpg" },
        { name: "article:published_time", value: "2026-10-05" },
        { name: "twitter:card", value: "summary_large_image" },
        { name: "twitter:description", value: "Twitter description" },
        { name: "og:site_name", value: "@example" },
        { name: "twitter:site", value: "@example" },
      ],
      "SEO and social tags keep their order, repeats and conflicts, while " +
        "unrelated and empty tags are left out."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_no_metadata() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { tab, getPageExtractor, cleanup } = await html`
    <p>A page with no metadata.</p>
  `;
  try {
    const metadata = await getPageExtractor().getStructuredMetadata();
    Assert.equal(
      metadata.url,
      tab.linkedBrowser.currentURI.spec,
      "The document URL is always given."
    );
    Assert.deepEqual(
      { ...metadata, url: null },
      EMPTY_METADATA,
      "A page without metadata produces empty collections."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_json_ld_blocks_are_kept_as_written() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": "#org", name: "Example Co" },
      {
        "@type": "Product",
        "@id": "https://example.com/p",
        name: "First name",
        brand: { "@id": "#org" },
      },
    ],
  };
  const conflicting = [
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "@id": "https://example.com/p",
      name: "Second name",
    },
  ];
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      ${JSON.stringify(graph)}
    </script>
    <script type="application/ld+json">
      ${JSON.stringify(conflicting)}
    </script>
  `;
  try {
    Assert.deepEqual(
      (await getPageExtractor().getStructuredMetadata()).jsonLd,
      [JSON.stringify(graph), JSON.stringify(conflicting)],
      "Each block is returned as written, and conflicting blocks stay separate."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_json_ld_invalid_blocks_do_not_block_others() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      { this is not valid json }
    </script>
    <script type="application/ld+json">
      "just a string"
    </script>
    <script type="application/ld+json"></script>
    <script type="APPLICATION/LD+JSON">
      { "@context": "https://schema.org/", "@type": "Product" }
    </script>
    <p>one two three</p>
  `;
  try {
    const { jsonLd, truncated } =
      await getPageExtractor().getStructuredMetadata();
    const { structuredDataTypes, wordCount } =
      await getPageExtractor().getPageMetadata();
    Assert.deepEqual(
      jsonLd,
      ['{"@context":"https://schema.org/","@type":"Product"}'],
      "Valid blocks are read after invalid ones."
    );
    Assert.strictEqual(
      truncated,
      false,
      "Skipping blocks the page wrote wrong is not truncation."
    );
    Assert.deepEqual(
      structuredDataTypes,
      ["Product"],
      "getPageMetadata reads the same blocks."
    );
    Assert.equal(wordCount, 3, "The rest of the page metadata is unaffected.");
  } finally {
    await cleanup();
  }
});

add_task(async function test_hostile_metadata_is_bounded() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const depth = 15_000;
  const deep = '{"a":'.repeat(depth) + "{}" + "}".repeat(depth);
  const huge = JSON.stringify({ "@type": "Thing", name: "x".repeat(200_000) });
  const { getPageExtractor, cleanup } = await html`
    <meta name="description" content=${"d".repeat(100_000)} />
    ${'<meta name="keywords" content="k" />'.repeat(100)}
    <script type="application/ld+json">
      ${huge}
    </script>
    <script type="application/ld+json">
      ${deep}
    </script>
    <script type="application/ld+json">
      { "@type": "Recipe" }
    </script>
  `;
  try {
    const { metaTags, jsonLd, truncated } =
      await getPageExtractor().getStructuredMetadata();
    Assert.ok(truncated, "The limits are visible to callers.");
    Assert.ok(
      metaTags.every(tag => tag.name == "keywords"),
      "A meta value too long to keep is left out whole in the content process."
    );
    Assert.equal(metaTags.length, 50, "The number of meta tags is capped.");
    Assert.deepEqual(
      jsonLd,
      ['{"@type":"Recipe"}'],
      "Blocks too large or too deeply nested are left out, and later blocks " +
        "are still read."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_truncated_only_reports_values_callers_receive() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const ignored = await html`
    <meta name="description" content="Short description" />
    <meta name="csrf-token" content=${"c".repeat(2000)} />
    <p>Page.</p>
  `;
  try {
    const metadata = await ignored.getPageExtractor().getStructuredMetadata();
    Assert.deepEqual(
      metadata.metaTags,
      [{ name: "description", value: "Short description" }],
      "The tag outside the allowlist is not returned."
    );
    Assert.strictEqual(
      metadata.truncated,
      false,
      "A long value on a tag that is left out does not count as truncation."
    );
  } finally {
    await ignored.cleanup();
  }

  const tooLong = await html`
    <title>${"t".repeat(2000)}</title>
    <link rel="canonical" href=${"/" + "p".repeat(2000)} />
    <meta
      property="og:image"
      content=${"https://example.com/" + "i".repeat(2000)}
    />
    <meta name="description" content="Short description" />
    <p>Page.</p>
  `;
  try {
    const metadata = await tooLong.getPageExtractor().getStructuredMetadata();
    Assert.strictEqual(
      metadata.title,
      "",
      "A title too long to keep is left out whole."
    );
    Assert.strictEqual(
      metadata.canonicalUrl,
      null,
      "A canonical URL too long to keep is left out, not cut into another URL."
    );
    Assert.deepEqual(
      metadata.metaTags,
      [{ name: "description", value: "Short description" }],
      "An allowlisted value too long to keep is left out whole."
    );
    Assert.strictEqual(
      metadata.truncated,
      true,
      "Leaving out a value the caller would receive counts as truncation."
    );
  } finally {
    await tooLong.cleanup();
  }
});

add_task(async function test_oversized_json_ld_block_is_skipped() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const huge = JSON.stringify({ "@type": "Thing", name: "x".repeat(150_000) });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      ${huge}
    </script>
    <script type="application/ld+json">
      { "@type": "Recipe" }
    </script>
  `;
  try {
    const { jsonLd, truncated } =
      await getPageExtractor().getStructuredMetadata();
    Assert.deepEqual(
      jsonLd,
      ['{"@type":"Recipe"}'],
      "The oversized block is skipped and the later small block is extracted."
    );
    Assert.strictEqual(
      truncated,
      true,
      "Skipping a block is reported to callers."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_invalid_json_ld_counts_against_the_budget() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const invalid = `{ "@type": "Thing", "name": "${"x".repeat(60_000)}" `;
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      ${invalid}
    </script>
    <script type="application/ld+json">
      ${invalid}
    </script>
    <script type="application/ld+json">
      { "@type": "Recipe" }
    </script>
  `;
  try {
    const { jsonLd, truncated } =
      await getPageExtractor().getStructuredMetadata();
    Assert.deepEqual(
      jsonLd,
      ['{"@type":"Recipe"}'],
      "The small valid block after the invalid ones is still read."
    );
    Assert.strictEqual(
      truncated,
      true,
      "The first invalid block spent the budget the second one needed."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_too_deeply_nested_json_ld_is_reported() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const depth = 15_000;
  const deep = '{"a":'.repeat(depth) + "{}" + "}".repeat(depth);
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      ${deep}
    </script>
    <script type="application/ld+json">
      "just a string"
    </script>
    <script type="application/ld+json">
      { "@type": "Recipe" }
    </script>
  `;
  try {
    const { jsonLd, truncated } =
      await getPageExtractor().getStructuredMetadata();
    Assert.deepEqual(
      jsonLd,
      ['{"@type":"Recipe"}'],
      "The deeply nested block and the string are left out."
    );
    Assert.strictEqual(
      truncated,
      true,
      "Dropping a valid block for its depth is reported to callers."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_url_is_null_for_non_http_documents() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    'data:text/html,<meta name="description" content="Inline page">',
    true
  );
  try {
    const metadata = await tab.linkedBrowser.browsingContext.currentWindowGlobal
      .getActor("PageExtractor")
      .getStructuredMetadata();
    Assert.strictEqual(
      metadata.url,
      null,
      "A data: document has no URL to resolve against."
    );
    Assert.deepEqual(
      metadata.metaTags,
      [{ name: "description", value: "Inline page" }],
      "Its metadata is still read."
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_url_over_the_length_limit_is_left_out() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { tab, getPageExtractor, cleanup } = await html`
    <meta name="description" content="Long address" />
    <p>Page.</p>
  `;
  const setBaseUrlLength = length =>
    SpecialPowers.spawn(tab.linkedBrowser, [length], targetLength => {
      const { document, location } = content;
      const base =
        document.querySelector("base") ??
        document.head.appendChild(document.createElement("base"));
      base.href =
        location.origin +
        "/" +
        "u".repeat(targetLength - location.origin.length - 1);
      return document.baseURI;
    });
  try {
    const atLimit = await setBaseUrlLength(1000);
    Assert.equal(atLimit.length, 1000, "The base URL is exactly at the limit.");
    let metadata = await getPageExtractor().getStructuredMetadata();
    Assert.strictEqual(metadata.url, atLimit, "A URL at the limit is kept.");
    Assert.strictEqual(metadata.truncated, false, "Nothing was left out.");

    const overLimit = await setBaseUrlLength(1001);
    Assert.equal(overLimit.length, 1001, "The base URL is one over the limit.");
    metadata = await getPageExtractor().getStructuredMetadata();
    Assert.strictEqual(
      metadata.url,
      null,
      "A URL over the limit is left out, not cut into another URL."
    );
    Assert.strictEqual(metadata.truncated, true, "Leaving it out is reported.");
    Assert.deepEqual(
      metadata.metaTags,
      [{ name: "description", value: "Long address" }],
      "The rest of the metadata is still read."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_document_fields() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { tab, getPageExtractor, cleanup } = await html`
    <title>Soupe aux tomates</title>
    <base href="/recettes/#haut" />
    <link rel="Canonical" href="soupe" />
    <p>Soupe.</p>
  `;
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.document.documentElement.lang = "fr-CA";
    });
    const { url, title, canonicalUrl, language } =
      await getPageExtractor().getStructuredMetadata();
    Assert.equal(
      url,
      new URL("/recettes/#haut", tab.linkedBrowser.currentURI.spec).href,
      "The URL is the document's full base URL, hash included."
    );
    Assert.equal(
      title,
      "Soupe aux tomates",
      "The document title is returned as written."
    );
    Assert.equal(
      canonicalUrl,
      new URL("soupe", url).href,
      "The canonical link resolves against the same base URL."
    );
    Assert.equal(
      language,
      "fr-CA",
      "The language is read from the root element's lang attribute."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_reader_picks_the_main_item_over_site_furniture() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <title>Tomato Soup | Example Kitchen</title>
    <meta property="og:title" content="Tomato Soup (Open Graph)" />
    <meta property="og:site_name" content="Example Kitchen" />
    <meta name="description" content="HTML description" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Organization",
            "@id": "#org",
            "name": "Example Kitchen Inc."
          },
          { "@type": "WebSite", "@id": "#site", "name": "Example Kitchen" },
          {
            "@type": "WebPage",
            "@id": "#page",
            "name": "Tomato Soup | Example Kitchen",
            "breadcrumb": {
              "@type": "BreadcrumbList",
              "itemListElement": [{ "@type": "ListItem", "position": 1 }]
            }
          },
          { "@type": "Person", "@id": "#ada", "name": "Ada" },
          {
            "@type": "schema:Recipe",
            "name": "Tomato Soup",
            "description": "A quick soup.",
            "author": [{ "@id": "#ada" }, { "@type": "Person", "name": "Bo" }],
            "publisher": { "@id": "#org" },
            "image": { "@type": "ImageObject", "url": "/soup.jpg" },
            "datePublished": "2026-10-05",
            "inLanguage": "en-US"
          }
        ]
      }
    </script>
    <p>Soup.</p>
  `;
  try {
    const metadata = await getPageExtractor().getStructuredMetadata();
    const reader = new StructuredMetadataReader(metadata);
    Assert.equal(
      reader.primaryItem?.["@type"],
      "schema:Recipe",
      "The recipe is the main item, not the organization, site or page."
    );
    Assert.equal(reader.title, "Tomato Soup");
    Assert.equal(reader.description, "A quick soup.");
    Assert.equal(
      reader.author,
      "Ada, Bo",
      "References and inline authors are both named."
    );
    Assert.equal(
      reader.image,
      new URL("/soup.jpg", metadata.url).href,
      "Image objects are resolved against the document."
    );
    Assert.equal(reader.publishedTime, "2026-10-05");
    Assert.equal(reader.siteName, "Example Kitchen");
    Assert.equal(reader.language, "en-US");
    Assert.equal(
      reader.findItems("Recipe").length,
      1,
      "Compact IRI types match their schema.org name."
    );
    Assert.equal(
      reader.findItems("ListItem").length,
      1,
      "Nested items are found."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_reader_finds_items_and_follows_references() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <meta property="og:title" content="Tomato Soup (Open Graph)" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Organization",
            "@id": "#org",
            "name": "Example Kitchen Inc."
          },
          {
            "@type": "WebPage",
            "breadcrumb": {
              "@type": "BreadcrumbList",
              "itemListElement": [{ "@type": "ListItem", "position": 1 }]
            }
          },
          { "@type": "Person", "@id": "#ada", "name": "Ada" },
          {
            "@type": "schema:Recipe",
            "name": "Tomato Soup",
            "author": [{ "@id": "#ada" }, { "@type": "Person", "name": "Bo" }],
            "publisher": { "@id": "#org" }
          }
        ]
      }
    </script>
    <p>Soup.</p>
  `;
  try {
    const reader = new StructuredMetadataReader(
      await getPageExtractor().getStructuredMetadata()
    );
    Assert.deepEqual(
      reader.items.map(item => item["@type"]),
      [
        "Organization",
        "WebPage",
        "BreadcrumbList",
        "ListItem",
        "Person",
        "schema:Recipe",
        "Person",
      ],
      "Every typed item is listed in document order, nested ones included."
    );
    const [recipe] = reader.findItems("Recipe");
    Assert.equal(
      recipe?.name,
      "Tomato Soup",
      "Compact IRI types match their schema.org name."
    );
    Assert.equal(
      reader.findItems("ListItem").length,
      1,
      "Nested items are found."
    );
    Assert.equal(
      reader.resolve(recipe.author[0]).name,
      "Ada",
      "A reference resolves to the item with that @id."
    );
    Assert.equal(
      reader.resolve(recipe.publisher).name,
      "Example Kitchen Inc.",
      "A reference resolves to an item declared earlier in the graph."
    );
    Assert.strictEqual(
      reader.resolve(recipe.author[1]),
      recipe.author[1],
      "An inline item is returned as is."
    );
    Assert.deepEqual(
      reader.metaValues("og:title"),
      ["Tomato Soup (Open Graph)"],
      "Meta tags are read by name."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_reader_falls_back_to_tags_and_document() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <title>Document title</title>
    <meta name="twitter:description" content="Twitter description" />
    <meta name="description" content="HTML description" />
    <meta name="author" content="Ada" />
    <meta property="og:image" content="javascript:alert(1)" />
    <meta name="twitter:image" content="https://example.com/card.jpg" />
    <meta property="og:url" content="https://example.com/canonical" />
    <meta property="article:published_time" content="2026-10-05T10:00:00Z" />
    <script type="application/ld+json">
      { "@type": "WebSite", "name": "Example" }
    </script>
    <p>Text.</p>
  `;
  try {
    const reader = new StructuredMetadataReader(
      await getPageExtractor().getStructuredMetadata()
    );
    Assert.equal(reader.primaryItem, null, "Site-level items are skipped.");
    Assert.equal(reader.title, "Document title");
    Assert.equal(reader.description, "Twitter description");
    Assert.equal(reader.author, "Ada");
    Assert.equal(
      reader.image,
      "https://example.com/card.jpg",
      "Only http(s) image URLs are returned."
    );
    Assert.equal(reader.canonicalUrl, "https://example.com/canonical");
    Assert.equal(reader.publishedTime, "2026-10-05T10:00:00Z");
    Assert.equal(reader.siteName, "Example");
    Assert.equal(reader.modifiedTime, null);
    Assert.equal(reader.language, null);
  } finally {
    await cleanup();
  }
});

add_task(async function test_reader_finds_events_in_a_listing() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      [
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          "itemListElement": [
            {
              "@type": "ListItem",
              "item": {
                "@type": "MusicEvent",
                "name": "Concert",
                "startDate": "2026-12-01T20:00",
                "location": { "@id": "#hall" }
              }
            },
            {
              "@type": "ListItem",
              "item": {
                "@type": "https://schema.org/SportsEvent",
                "name": "Match",
                "location": { "@type": "Place", "name": "Stadium" }
              }
            }
          ]
        },
        { "@type": "Place", "@id": "#hall", "name": "Hall" }
      ]
    </script>
  `;
  try {
    const reader = new StructuredMetadataReader(
      await getPageExtractor().getStructuredMetadata()
    );
    const events = reader.findItems("Event", "MusicEvent", "SportsEvent");
    Assert.deepEqual(
      events.map(event => [event.name, reader.resolve(event.location).name]),
      [
        ["Concert", "Hall"],
        ["Match", "Stadium"],
      ],
      "Nested events are found in document order, and references resolve."
    );
    Assert.deepEqual(
      reader.findItems("Event"),
      [],
      "Subtypes are not inferred."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_reader_primary_item_can_be_overridden() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      [
        { "@type": "Product", "name": "First product" },
        { "@type": "Product", "name": "Second product" }
      ]
    </script>
  `;
  try {
    const reader = new StructuredMetadataReader(
      await getPageExtractor().getStructuredMetadata()
    );
    Assert.equal(
      reader.title,
      "First product",
      "By default the first item in document order is the primary one."
    );
    reader.primaryItem = reader.findItems("Product")[1];
    Assert.equal(
      reader.primaryItem?.name,
      "Second product",
      "The assigned item replaces the heuristic's choice."
    );
    Assert.equal(
      reader.title,
      "Second product",
      "The title follows the assigned item."
    );
  } finally {
    await cleanup();
  }
});

/**
 * primaryItem on pages shaped like SEO and shop plugin output. The fixtures
 * are trimmed from a Yoast blog index, a WooCommerce product page and a Yoast
 * with WP Recipe Maker recipe blog. Mirrors the reader tests above.
 */
add_task(async function test_reader_primary_item_on_plugin_generated_pages() {
  const yoastBlogIndex = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["WebPage", "CollectionPage"],
        "@id": "https://example.com/blog/",
        name: "Blog",
        isPartOf: { "@id": "https://example.com/#website" },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [{ "@type": "ListItem", position: 1 }],
      },
      {
        "@type": "WebSite",
        "@id": "https://example.com/#website",
        name: "Example",
        potentialAction: [
          {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: "https://example.com/?s={search_term_string}",
            },
          },
        ],
      },
      { "@type": ["Organization", "Brand"], name: "Example" },
    ],
  };
  const productPage = [
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": ["WebPage", "ItemPage"],
          "@id": "https://example.com/products/pot/",
          name: "Soup pot - Example",
          potentialAction: { "@type": "BuyAction" },
        },
        { "@type": "ImageObject", url: "https://example.com/pot.jpg" },
        { "@type": "WebSite", name: "Example" },
      ],
    },
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Product",
          "@id": "https://example.com/products/pot/#product",
          mainEntityOfPage: { "@id": "https://example.com/products/pot/" },
          name: "Soup pot",
          offers: { "@type": "Offer", price: "19.99" },
          potentialAction: { "@type": "BuyAction" },
        },
      ],
    },
  ];
  const recipePost = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": "https://example.com/lasagna/#article",
        headline: "Easy Homemade Lasagna",
        potentialAction: [{ "@type": "CommentAction" }],
      },
      {
        "@type": "WebPage",
        "@id": "https://example.com/lasagna/",
        name: "Easy Homemade Lasagna Recipe - Example",
      },
      { "@type": "Person", name: "Ada" },
      {
        "@type": "Recipe",
        "@id": "https://example.com/lasagna/#recipe",
        mainEntityOfPage: "https://example.com/lasagna/",
        isPartOf: { "@id": "https://example.com/lasagna/#article" },
        name: "Easy Homemade Lasagna",
        recipeInstructions: [{ "@type": "HowToStep", text: "Layer." }],
      },
    ],
  };

  const itemPageWithMainEntity = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "Example" },
      {
        "@type": "ItemPage",
        name: "Soup pot - Example",
        mainEntity: { "@type": "Product", name: "Soup pot" },
      },
    ],
  };

  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  for (const [blocks, expectedType, message] of [
    [
      [yoastBlogIndex],
      ["WebPage", "CollectionPage"],
      "A blog index is its page, not the site search's EntryPoint.",
    ],
    [
      productPage,
      "Product",
      "A product page is its Product, not the page's BuyAction.",
    ],
    [
      [recipePost],
      "Recipe",
      "The Recipe declaring mainEntityOfPage wins over the earlier Article.",
    ],
    [
      [itemPageWithMainEntity],
      "Product",
      "A page's inline mainEntity is a candidate, and wins over the page.",
    ],
  ]) {
    const page = await html`
      ${blocks
        .map(
          block =>
            `<script type="application/ld+json">${JSON.stringify(block)}</script>`
        )
        .join("\n")}
      <p>Page.</p>
    `;
    try {
      const reader = new StructuredMetadataReader(
        await page.getPageExtractor().getStructuredMetadata()
      );
      Assert.deepEqual(reader.primaryItem?.["@type"], expectedType, message);
    } finally {
      await page.cleanup();
    }
  }
});

/**
 * A feature reads a product price from the page the way the "read a product
 * price" example in docs/index.md shows. Mirrors the reader tests above.
 */
add_task(async function test_reader_reads_a_product_price_as_documented() {
  const readPrice = async getPageExtractor => {
    const pageExtractor = getPageExtractor();
    const reader = new StructuredMetadataReader(
      await pageExtractor.getStructuredMetadata()
    );
    const [product] = reader.findItems("Product");
    const offers = [reader.resolve(product?.offers)]
      .flat()
      .map(offer => reader.resolve(offer));
    return (
      offers.find(offer => offer?.price != null)?.price ??
      reader.metaValues("product:price:amount")[0]
    );
  };

  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const withJsonLd = await html`
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": "Shop"
      }
    </script>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Soup pot",
        "offers": [
          { "@type": "Offer", "availability": "InStock" },
          { "@id": "#sale" }
        ]
      }
    </script>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Offer",
        "@id": "#sale",
        "price": "19.99"
      }
    </script>
    <p>A soup pot.</p>
  `;
  try {
    Assert.equal(
      await readPrice(withJsonLd.getPageExtractor),
      "19.99",
      "A price reached through an @id reference in another block is found."
    );
  } finally {
    await withJsonLd.cleanup();
  }

  const withMetaOnly = await html`
    <meta property="product:price:amount" content="7.50" />
    <meta property="product:price:currency" content="EUR" />
    <p>A soup pot.</p>
  `;
  try {
    Assert.equal(
      await readPrice(withMetaOnly.getPageExtractor),
      "7.50",
      "Without JSON-LD the Open Graph product price is used."
    );
  } finally {
    await withMetaOnly.cleanup();
  }
});

add_task(async function test_reader_without_a_base_url_keeps_absolute_urls() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," +
      '<meta property="og:image" content="/relative.jpg">' +
      '<meta name="twitter:image" content="https://example.com/card.jpg">',
    true
  );
  try {
    const metadata = await tab.linkedBrowser.browsingContext.currentWindowGlobal
      .getActor("PageExtractor")
      .getStructuredMetadata();
    Assert.strictEqual(metadata.url, null, "A data: page has no base URL.");
    Assert.strictEqual(
      new StructuredMetadataReader(metadata).image,
      "https://example.com/card.jpg",
      "A relative image has nothing to resolve against, so the absolute one is used."
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
