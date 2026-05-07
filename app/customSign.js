// No-op signing hook for electron-builder.
// Keeps build config valid before real code-sign workflow is finalized.
exports.default = async function customSign() {
  // Intentionally empty.
}
