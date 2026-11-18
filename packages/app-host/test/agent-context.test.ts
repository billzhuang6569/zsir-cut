import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseProject } from "../../core/src/index.ts";
import { agentContext } from "../src/agent-context.js";
import type { UiState } from "../src/ui.js";

const fixture = parseProject(readFileSync("examples/interview.zcut.json", "utf8"));
if (!fixture.ok) throw new Error("Invalid interview fixture");

const state: UiState = {
  project: "examples/interview.zcut.json",
  panel: "subtitles",
  sub: "style",
  playhead: { at: "1001/200s" },
  selected: [],
  playing: false,
  range: null,
  loop: false,
};
const header = "<界面>\n工程：采访示例，修订 rev_example_1（第 1 步），时间线 tl_main，总长 00:00:23;00";

it("formats the selected clip, subtitle and marker with drop-frame timecode and in/out marks", () => {
  expect(
    agentContext(
      fixture.project,
      { ...state, selected: ["clp_v_1", "cue_2", "mrk_2"], timelineMarks: { in: "0s", out: "1001/200s" } },
      2,
    ),
  ).toBe(`${header}
播放头：01:00:05;00（1001/200s）
入出点：01:00:00;00–01:00:05;00
选中：片段 clp_v_1（V1 主机位，01:00:00;00–01:00:05;00，素材「采访 A 机.mov」）；字幕条 cue_2（剪辑师不该做重复劳动）；标记 mrk_2（字幕跨切点：cue_3 后半句随 A1 ）
正在看：字幕，样式
待你决定：2 条
</界面>`);
});

it("writes empty fields when nothing is selected and keeps project context when disconnected", () => {
  expect(agentContext(fixture.project, { ...state, panel: "ai", sub: null }, 0)).toBe(`${header}
播放头：01:00:05;00（1001/200s）
入出点：无
选中：无
正在看：AI
待你决定：0 条
</界面>`);
  expect(agentContext(fixture.project, null, 3)).toBe(`${header}
界面没有打开
待你决定：3 条
</界面>`);
});

it("uses the timeline boundary for a single mark, as the desktop timeline does", () => {
  expect(agentContext(fixture.project, { ...state, timelineMarks: { in: "1001/200s", out: null } }, 0)).toContain(
    "入出点：01:00:05;00–01:00:23;00",
  );
  expect(agentContext(fixture.project, { ...state, timelineMarks: { in: null, out: "1001/200s" } }, 0)).toContain(
    "入出点：01:00:00;00–01:00:05;00",
  );
});

it("limits the selection to ten and drops whole entries to fit 1500 characters", () => {
  const selected = Array.from({ length: 12 }, (_, i) => `clp_${i}`);
  expect(agentContext(fixture.project, { ...state, selected }, 0)).toContain(
    `选中：${selected.slice(0, 10).join("；")}；等 2 个\n`,
  );
  const long = Array.from({ length: 12 }, (_, i) => `clp_${i}_${"长".repeat(190)}`);
  const context = agentContext(fixture.project, { ...state, selected: long }, 0);
  expect(context.length).toBeLessThanOrEqual(1500);
  expect(context).toContain(
    `选中：${long.slice(0, 6).join("；")}；等 6 个\n正在看：字幕，样式\n待你决定：0 条\n</界面>`,
  );
});
