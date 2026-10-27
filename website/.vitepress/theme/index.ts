// The Atticus site's theme: VitePress's default theme without its bundled fonts, with the app's
// own type (IBM Plex Sans and JetBrains Mono, self-hosted from @fontsource, OFL-1.1) and a quieter
// echo of the app's HUD colours (style.css). The landing page is its own component.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-400-italic.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import DefaultTheme from "vitepress/theme-without-fonts";
import type { Theme } from "vitepress";
import Landing from "./Landing.vue";
import "./style.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("Landing", Landing);
  },
} satisfies Theme;
