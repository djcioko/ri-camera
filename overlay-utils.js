(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RIOverlayUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function clampOverlay(state, bounds) {
    const aspect = state.aspect || state.w / state.h || 1;
    const maxWidth = Math.max(1, Math.min(bounds.width, bounds.height * aspect));
    const width = clamp(state.w, 1, maxWidth);
    const height = width / aspect;
    return {
      ...state,
      aspect,
      w: width,
      h: height,
      x: clamp(state.x, 0, bounds.width - width),
      y: clamp(state.y, 0, bounds.height - height),
    };
  }

  function scaleOverlay(state, factor, bounds, minWidth = 48) {
    const aspect = state.aspect || state.w / state.h || 1;
    const centerX = state.x + state.w / 2;
    const centerY = state.y + state.h / 2;
    const maxWidth = Math.max(1, Math.min(bounds.width, bounds.height * aspect));
    const floor = Math.min(minWidth, maxWidth);
    const width = clamp(state.w * factor, floor, maxWidth);
    const height = width / aspect;
    return clampOverlay({
      ...state,
      aspect,
      w: width,
      h: height,
      x: centerX - width / 2,
      y: centerY - height / 2,
    }, bounds);
  }

  return { clampOverlay, scaleOverlay };
});
