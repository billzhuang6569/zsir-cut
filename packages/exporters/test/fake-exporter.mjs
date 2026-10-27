import { cuttingList } from "../../core/dist/index.js";
export default {
  version: "test-1",
  git_sha: "0000000",
  async generate(project, timeline, profile) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { name: "timeline.json", data: `${JSON.stringify(cuttingList(project, timeline, profile))}\n` };
  },
  async readBack(data) {
    return JSON.parse(data.toString());
  },
  losses() {
    return [];
  },
  async validate(data) {
    return Array.isArray(JSON.parse(data.toString()));
  },
};
