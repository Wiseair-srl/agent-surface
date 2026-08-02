import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { slug } from "github-slugger";

export default withMermaid(
  defineConfig({
    title: "agent-surface",
    description: "Compiler-authorized, typed frontend capabilities for agents.",
    lang: "en-US",
    markdown: {
      anchor: { slugify: (s) => slug(s) },
    },
    themeConfig: {
      nav: [
        { text: "Getting started", link: "/getting-started" },
        { text: "Architecture", link: "/02-architecture" },
        { text: "Core API", link: "/03-core-api" },
        { text: "CLI", link: "/20-cli" },
        { text: "Example", link: "/10-examples" },
      ],
      sidebar: [
        {
          text: "Start",
          items: [
            { text: "Overview", link: "/" },
            { text: "Getting started", link: "/getting-started" },
            { text: "Example application", link: "/10-examples" },
          ],
        },
        {
          text: "Understand",
          items: [
            { text: "Why agent-surface", link: "/00-vision" },
            { text: "Concepts", link: "/01-concepts" },
            { text: "Architecture", link: "/02-architecture" },
            { text: "Policies and security", link: "/06-policies-and-security" },
            { text: "Limits and non-goals", link: "/11-non-goals" },
          ],
        },
        {
          text: "Build",
          items: [
            { text: "Core API", link: "/03-core-api" },
            { text: "React API", link: "/04-react-api" },
            { text: "oRPC integration", link: "/05-orpc-integration" },
            { text: "Adapters", link: "/09-adapters" },
          ],
        },
        {
          text: "Verify and operate",
          items: [
            { text: "Testing", link: "/08-testing" },
            { text: "Error model", link: "/07-errors" },
            { text: "CLI", link: "/20-cli" },
          ],
        },
      ],
      outline: { level: [2, 3], label: "On this page" },
      search: { provider: "local" },
      footer: {
        message: "Compiler-authorized frontend capabilities for agents.",
      },
    },
  }),
);
