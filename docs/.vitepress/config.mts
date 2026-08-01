import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { slug } from "github-slugger";

export default withMermaid(
  defineConfig({
    title: "agent-surface",
    description:
      "An explicit, semantic, typed, governable agent surface for frontend applications — specification and v0.1 implementation.",
    lang: "en-US",
    markdown: {
      // Match GitHub's slugger so the cross-doc anchors written for GitHub
      // (e.g. #collisions-d4, #binding-semantics-d7-d8--draft) resolve here too.
      anchor: { slugify: (s) => slug(s) },
    },
    themeConfig: {
      nav: [
        { text: "Getting Started", link: "/getting-started" },
        { text: "Concepts", link: "/01-concepts" },
        { text: "Core API", link: "/03-core-api" },
        { text: "CLI", link: "/20-cli" },
        { text: "Example", link: "/10-examples" },
      ],
      sidebar: [
        {
          text: "Start here",
          items: [{ text: "Getting Started", link: "/getting-started" }],
        },
        {
          text: "Foundations",
          items: [
            { text: "Vision", link: "/00-vision" },
            { text: "Concepts", link: "/01-concepts" },
            { text: "Architecture", link: "/02-architecture" },
            { text: "Non-Goals", link: "/11-non-goals" },
          ],
        },
        {
          text: "API Reference",
          items: [
            { text: "Core API", link: "/03-core-api" },
            { text: "React API", link: "/04-react-api" },
            { text: "oRPC Integration", link: "/05-orpc-integration" },
            { text: "CLI", link: "/20-cli" },
          ],
        },
        {
          text: "Runtime Contracts",
          items: [
            { text: "Policies & Security", link: "/06-policies-and-security" },
            { text: "Errors", link: "/07-errors" },
            { text: "Testing", link: "/08-testing" },
            { text: "Adapters", link: "/09-adapters" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "Devices Page, End to End", link: "/10-examples" },
            {
              text: "Mastra + assistant-ui (wiring sketch)",
              link: "/16-mastra-assistant-ui",
            },
          ],
        },
        {
          // How the project is run, and why it decided what it decided. Kept out
          // of the reading path above and collapsed by default: an adopter needs
          // none of it, a reviewer wants all of it. The maintainer directive is
          // deliberately absent — it is addressed to the implementer, not to a
          // reader of the docs, and stays reachable by link.
          text: "Project",
          collapsed: true,
          items: [
            { text: "Roadmap", link: "/project/12-roadmap" },
            { text: "Decisions & Open Questions", link: "/project/13-open-questions" },
            { text: "Completeness Review", link: "/project/15-completeness-review" },
            { text: "Implementation Plan (historical)", link: "/project/14-implementation-plan" },
            { text: "RFC — Spec Corrections (P0)", link: "/project/18-spec-corrections-rfc" },
            { text: "RFC — Catalog Scale (P1)", link: "/project/19-catalog-scale-rfc" },
            { text: "RFC — Surface Coverage (P1)", link: "/project/21-surface-coverage-rfc" },
          ],
        },
      ],
      outline: { level: [2, 3], label: "On this page" },
      search: { provider: "local" },
      footer: {
        message: "Specification + implementation, published on npm as 0.x. Nothing is Stable yet.",
      },
    },
  }),
);
