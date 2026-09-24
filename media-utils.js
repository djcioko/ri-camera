(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RIMediaUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const formats = [
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4", needsConversion: false },
    { mimeType: "video/mp4;codecs=h264,aac", extension: "mp4", needsConversion: false },
    { mimeType: "video/mp4", extension: "mp4", needsConversion: false },
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm", needsConversion: true },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm", needsConversion: true },
    { mimeType: "video/webm", extension: "webm", needsConversion: true },
  ];

  function selectRecordingFormat(isTypeSupported) {
    return formats.find((format) => isTypeSupported(format.mimeType)) || formats[formats.length - 1];
  }

  return { selectRecordingFormat };
});
