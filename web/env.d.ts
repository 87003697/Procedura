// Bun bundles `import index from "./index.html"` into an HTMLBundle that
// Bun.serve understands as a route. Declare the module shape for tsc.
declare module "*.html" {
  const content: import("bun").HTMLBundle;
  export default content;
}
