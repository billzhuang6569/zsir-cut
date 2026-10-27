import exporter from "./fake-exporter.mjs";
export default {
  ...exporter,
  async generate(...args) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return exporter.generate(...args);
  },
};
