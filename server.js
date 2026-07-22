try {
  require("./dist/server.js");
} catch (error) {
  console.error("Failed to load compiled admin server.");
  console.error("Run 'npm run build' first, then 'npm run admin'.");
  console.error(error);
  process.exit(1);
}
