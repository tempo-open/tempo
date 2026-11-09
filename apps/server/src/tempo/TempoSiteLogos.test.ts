import { describe, expect, it } from "vite-plus/test";

import { readHomePage, siteName } from "./TempoSiteLogos.ts";

describe("siteName", () => {
  it.each([
    ["acme.com", "acme"],
    ["app.acme.co.uk", "acme"],
    ["examplewidgets.com", "examplewidgets"],
    ["example.ai", "example"],
  ])("%s is %s", (domain, name) => {
    expect(siteName(domain)).toBe(name);
  });
});

describe("readHomePage", () => {
  it("reads the page's names and puts the apple touch icon first, without SVGs", () => {
    const page = readHomePage(
      `<html><head>
        <title>Acme - Example Company</title>
        <meta property="og:site_name" content="Acme">
        <link rel="icon" type="image/png" sizes="32x32" href="/images/acme-favicon.png">
        <link rel="icon" type="image/svg+xml" href="/logo.svg">
        <link rel='apple-touch-icon' sizes=180x180 href='https://cdn.acme.com/touch.png'>
        <link rel="stylesheet" href="/site.css">
      </head></html>`,
      "https://acme.com/",
    );
    expect(page.names).toContain("Acme - Example Company");
    expect(page.icons).toEqual([
      "https://cdn.acme.com/touch.png",
      "https://acme.com/images/acme-favicon.png",
      "https://acme.com/favicon.ico",
    ]);
  });
});
