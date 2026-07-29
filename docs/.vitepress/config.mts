import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { slug } from "github-slugger";

export default withMermaid(
  defineConfig({
    title: "agent-surface",
    description:
      "An explicit, semantic, typed, governable agent surface for frontend applications — design-phase specification.",
    lang: "en-US",
    markdown: {
      // Match GitHub's slugger so the cross-doc anchors written for GitHub
      // (e.g. #collisions-d4, #binding-semantics-d7-d8--draft) resolve here too.
      anchor: { slugify: (s) => slug(s) },
    },
    themeConfig: {
      nav: [
        { text: "Vision", link: "/00-vision" },
        { text: "Concepts", link: "/01-concepts" },
        { text: "Core API", link: "/03-core-api" },
        { text: "Example", link: "/10-examples" },
      ],
      sidebar: [
        {
          text: "Foundations",
          items: [
            { text: "Vision", link: "/00-vision" },
            { text: "Concepts", link: "/01-concepts" },
            { text: "Architecture", link: "/02-architecture" },
          ],
        },
        {
          text: "API Reference",
          items: [
            { text: "Core API", link: "/03-core-api" },
            { text: "React API", link: "/04-react-api" },
            { text: "oRPC Integration", link: "/05-orpc-integration" },
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
          text: "Worked Examples",
          items: [
            { text: "Devices Page, End to End", link: "/10-examples" },
            { text: "Mastra + assistant-ui Chat", link: "/16-mastra-assistant-ui" },
          ],
        },
        {
          text: "Project",
          items: [
            { text: "Non-Goals", link: "/11-non-goals" },
            { text: "Roadmap", link: "/12-roadmap" },
            { text: "Decisions & Open Questions", link: "/13-open-questions" },
            { text: "Implementation Plan", link: "/14-implementation-plan" },
            { text: "Completeness Review", link: "/15-completeness-review" },
          ],
        },
      ],
      outline: { level: [2, 3], label: "On this page" },
      search: { provider: "local" },
      footer: {
        message: "Design-phase specification — nothing is implemented or published yet.",
      },
    },
  }),
);
