/* @ds-bundle: {"format":4,"namespace":"ZsirCut","components":[{"name":"Icon"},{"name":"Button"},{"name":"IconButton"},{"name":"Tabs"},{"name":"Switch"},{"name":"StatusPill"},{"name":"Kbd"},{"name":"DecisionCard"},{"name":"DecisionProgress"},{"name":"StepRow"},{"name":"FileIcon"},{"name":"DestinationCard"},{"name":"SubtitleRow"},{"name":"Clip"}]} */
(function () {
  var React = window.React, h = React.createElement;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }

  var PATHS = {
    'select': 'M3 2l10 5.5-4.5 1.2L7 13z',
    'blade': 'M3 13 13 3M10 3h3v3',
    'marker': 'M4 14V2h8l-2 3 2 3H4',
    'undo': 'M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8H6',
    'redo': 'M11 3l3 3-3 3M14 6H7a4 4 0 0 0 0 8h3',
    'snap': 'M4 2v6a4 4 0 0 0 8 0V2M4 5h2.5M9.5 5H12',
    'export': 'M8 10V2M5 5l3-3 3 3M3 10v4h10v-4',
    'search': 'M10.5 10.5 14 14M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z',
    'replace': 'M2 4h8M7 1.5 10 4 7 6.5M14 12H6M9 9.5 6 12l3 2.5',
    'grid': 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
    'list': 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5',
    'plus': 'M8 3v10M3 8h10',
    'trash': 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9',
    'chevron': 'M6 3l5 5-5 5',
    'prev': 'M11 3 5 8l6 5',
    'next': 'M5 3l6 5-6 5',
    'down': 'M4 6l4 4 4-4',
    'close': 'M4 4l8 8M12 4l-8 8',
    'spark': 'M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12',
    'new-chat': 'M8 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V8M12 2l2 2-5.5 5.5H6.5v-2z',
    'copy': 'M5 5h8.5v8.5H5zM3 10.5V3.5A1 1 0 0 1 4 2.5h6.5',
    'clip': 'M1.5 4h13v8h-13zM5.5 4v8M10.5 4v8',
    'subtitle': 'M1.5 3h13v10h-13zM4 8.5h3M8.5 8.5H12M4 10.5h5',
    'md': 'M1.5 3.5h13v9h-13zM4 10V6l2 2 2-2v4M11 6v4M9.5 8.5 11 10l1.5-1.5',
    'play': 'M4 2.5v11l9-5.5z',
    'stop': 'M4 4h8v8H4z',
    'check': 'M3 8.5l3 3 7-7',
    'send': 'M2 8l12-5.5L9.5 14 7.5 9z M7.5 9 14 2.5',
    'skip': 'M3 3l6 5-6 5M12 3v10',
    'ask': 'M2.5 3h11v7.5h-6L4.5 13v-2.5h-2zM5.5 5.8h5M5.5 8h3'
  };
  var FILLED = { 'play': 1, 'stop': 1 };

  function Icon(p) {
    var size = p.size || 14, name = p.name;
    return h('svg', { className: cx('zc-icon', p.className), width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true',
      fill: FILLED[name] ? 'currentColor' : 'none', stroke: FILLED[name] ? 'none' : 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: PATHS[name] || '' }));
  }

  function Button(p) {
    var variant = p.variant || 'secondary', icon = p.icon;
    var rest = Object.assign({}, p); delete rest.variant; delete rest.icon; delete rest.children; delete rest.className;
    return h('button', Object.assign({ type: 'button', className: cx('zc-btn', 'zc-btn-' + variant, p.className) }, rest),
      icon ? h(Icon, { name: icon }) : null, p.children);
  }

  function IconButton(p) {
    var rest = Object.assign({}, p); ['icon', 'label', 'pressed', 'size', 'bordered', 'className'].forEach(function (k) { delete rest[k]; });
    var attrs = { type: 'button', title: p.label, 'aria-label': p.label, className: cx('zc-ibtn', p.size === 'compact' && 'zc-ibtn-compact', p.bordered && 'zc-ibtn-bordered', p.className) };
    if (p.pressed !== undefined) attrs['aria-pressed'] = String(!!p.pressed);
    return h('button', Object.assign(attrs, rest), h(Icon, { name: p.icon }));
  }

  function Tabs(p) {
    var st = React.useState(p.value != null ? p.value : (p.items[0] && p.items[0].id));
    var value = p.value != null ? p.value : st[0];
    return h('div', { role: 'tablist', 'aria-label': p.label, className: 'zc-tabs' },
      p.items.map(function (it) {
        var on = it.id === value;
        return h('button', { key: it.id, type: 'button', role: 'tab', 'aria-selected': String(on), className: 'zc-tab',
          title: it.icon ? it.label : undefined, 'aria-label': it.icon ? it.label : undefined,
          onClick: function () { st[1](it.id); p.onChange && p.onChange(it.id); } },
          it.icon ? h(Icon, { name: it.icon }) : it.label);
      }));
  }

  function Switch(p) {
    return h('label', { className: 'zc-switch-row', title: p.tip },
      h('span', null, p.label),
      h('input', { type: 'checkbox', role: 'switch', className: 'zc-switch', 'aria-label': p.label, defaultChecked: p.defaultChecked, checked: p.checked, onChange: p.onChange, disabled: p.disabled }));
  }

  function StatusPill(p) {
    return h('span', { className: cx('zc-pill', 'zc-pill-' + (p.tone || 'neutral')) },
      h('span', { className: 'zc-dot', 'aria-hidden': 'true' }), p.children);
  }

  function Kbd(p) { return h('kbd', { className: 'zc-kbd' }, p.children); }

  // 决定：一次一件。头部是图标、标题和进度环；正文是问题、一句背景、带字母键的选项；底部是「跳过」和「下一件 ⌘↵」。
  var LETTERS = 'ABCDEFGHIJ';
  function DecisionProgress(p) {
    var total = Math.max(1, p.total || 1), done = Math.min(total, p.done || 0), r = 6.5, c = 2 * Math.PI * r;
    return h('svg', { className: 'zc-ring', width: 16, height: 16, viewBox: '0 0 16 16', role: 'img', 'aria-label': done + ' / ' + total + ' 已定' },
      h('title', null, done + ' / ' + total + ' 已定'),
      h('circle', { cx: 8, cy: 8, r: r, className: 'zc-ring-track' }),
      h('circle', { cx: 8, cy: 8, r: r, className: 'zc-ring-done', strokeDasharray: (c * done / total).toFixed(2) + ' ' + c.toFixed(2), transform: 'rotate(-90 8 8)' }));
  }
  function DecisionCard(p) {
    var opts = p.options || [];
    var sel = React.useState(p.selected != null ? p.selected : -1), other = React.useState(p.otherText || '');
    var pick = sel[0], otherIdx = opts.length, ready = pick > -1 && (pick < otherIdx || other[0].trim() !== '');
    function key(i) { return h('span', { className: 'zc-q-key', 'aria-hidden': 'true' }, LETTERS[i]); }
    return h('section', { className: 'zc-q', 'aria-label': p.question },
      h('div', { className: 'zc-q-head' },
        h('span', { className: 'zc-q-badge', 'aria-hidden': 'true' }, h(Icon, { name: 'ask', size: 14 })),
        h('span', { className: 'zc-q-title' }, p.title || '决定'),
        h('span', { className: 'zc-grow' }),
        h(DecisionProgress, { done: p.done, total: p.total })),
      h('h3', { className: 'zc-q-question' }, p.question),
      p.context ? h('p', { className: 'zc-q-context' }, p.context) : null,
      h('div', { className: 'zc-q-options', role: 'radiogroup', 'aria-label': p.question },
        opts.map(function (o, i) {
          var on = pick === i;
          return h('button', { key: i, type: 'button', role: 'radio', 'aria-checked': String(on), className: cx('zc-q-option', on && 'is-on'), title: o.note, onClick: function () { sel[1](i); } },
            key(i),
            h('span', { className: 'zc-q-label' }, o.label),
            o.recommended ? h('span', { className: 'zc-q-rec', title: 'AI 推荐', 'aria-label': 'AI 推荐' }, h(Icon, { name: 'spark', size: 12 })) : null);
        }),
        p.allowOther === false ? null : h('label', { className: cx('zc-q-option', 'zc-q-other', pick === otherIdx && 'is-on') },
          key(otherIdx),
          h('input', { className: 'zc-q-other-input', placeholder: '其他想法…', 'aria-label': '其他想法', value: other[0], onChange: function (e) { other[1](e.target.value); }, onFocus: function () { sel[1](otherIdx); } }))),
      h('div', { className: 'zc-q-foot' },
        h('button', { type: 'button', className: 'zc-q-skip' }, '跳过'),
        h('button', { type: 'button', className: 'zc-q-next', disabled: !ready },
          p.last ? '发给 AI' : '下一件',
          h('span', { className: 'zc-q-keys', 'aria-hidden': 'true' }, h('kbd', null, '⌘'), h('kbd', null, '↵')))));
  }

  function StepRow(p) {
    return h('button', { type: 'button', className: cx('zc-step', p.live && 'is-live'), 'aria-expanded': String(!!p.expanded) },
      h('span', { className: 'zc-step-dot', 'aria-hidden': 'true' }),
      h('span', { className: 'zc-grow' }, p.children),
      h(Icon, { name: 'chevron', size: 12 }));
  }

  var FILE_COLOR = { fcpxml: 'var(--file-fcpxml)', otio: 'var(--file-otio)', xml: 'var(--file-xml)', srt: 'var(--file-srt)', mp4: 'var(--file-mp4)', wav: 'var(--file-wav)' };
  function FileIcon(p) {
    var ext = String(p.ext || '').toUpperCase(), color = FILE_COLOR[String(p.ext || '').toLowerCase()] || 'var(--text-3)';
    var body = h('span', { className: 'zc-file' },
      h('svg', { width: 38, height: 46, viewBox: '0 0 38 46', 'aria-hidden': 'true' },
        h('path', { d: 'M3 1h22l10 10v32a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z', className: 'zc-file-page' }),
        h('path', { d: 'M25 1v8a2 2 0 0 0 2 2h8', className: 'zc-file-fold' }),
        h('rect', { x: 1, y: 26, width: 30, height: 12, rx: 2, style: { fill: color } }),
        h('text', { x: 16, y: 35, textAnchor: 'middle', className: 'zc-file-ext', style: { fontSize: ext.length > 4 ? '6.5px' : '8px' } }, ext)),
      p.name ? h('span', { className: 'zc-file-name' }, p.name) : null,
      p.sub ? h('span', { className: 'zc-file-sub' }, p.sub) : null);
    if (p.toggle === undefined) return body;
    return h('button', { type: 'button', 'aria-pressed': String(!!p.toggle), 'aria-label': '导出 ' + ext, className: cx('zc-file-toggle', p.toggle && 'is-on') },
      p.toggle ? h('span', { className: 'zc-file-check' }, h(Icon, { name: 'check', size: 10 })) : null, body);
  }

  // 去处：一行排完。左边软件，中间输出物，右边进入。状态是名字旁的小图标，说明进悬停提示。
  function DestinationCard(p) {
    var verified = p.badge && p.badge.tone === 'approved';
    return h('button', { type: 'button', className: cx('zc-dest', p.hot && 'is-hot'), 'aria-label': '导出到 ' + p.name, title: p.sub },
      p.logo ? h('img', { className: 'zc-app-logo', src: p.logo, alt: '', width: 40, height: 40 }) : h('span', { className: 'zc-app-tile', style: { background: p.tint || 'var(--raised-2)' }, 'aria-hidden': 'true' }, p.mark),
      h('span', { className: 'zc-dest-name' },
        h('span', { className: 'zc-heading' }, p.name),
        verified ? h('span', { className: 'zc-dest-ok', title: p.badge.text, 'aria-label': p.badge.text }, h(Icon, { name: 'check', size: 12 })) : null,
        p.warning ? h('span', { className: 'zc-warn', title: p.warning, 'aria-label': '注意：' + p.warning }, '!') : null),
      h('span', { className: 'zc-dest-files' }, p.children),
      h('span', { className: 'zc-dest-chev', 'aria-hidden': 'true' }, h(Icon, { name: 'chevron', size: 16 })));
  }

  // 字幕行只给文字。时间在时间线上看和改（拖字幕条的边），列表里不放时码。
  function SubtitleRow(p) {
    return h('li', { className: cx('zc-sub-row', p.editing && 'is-editing', p.flagged && 'is-flagged'), title: p.editing ? undefined : '点一下跳到这里，回车编辑' },
      h('span', { className: 'zc-sub-n' }, p.n),
      p.editing
        ? h('textarea', { className: 'zc-input zc-textarea zc-sub-edit', rows: 2, defaultValue: p.text, 'aria-label': '字幕文字' })
        : h('span', { className: 'zc-sub-text' }, p.text),
      h('span', { className: 'zc-sub-actions' }, h(IconButton, { icon: 'plus', label: '在后面加一条', size: 'compact' }), h(IconButton, { icon: 'trash', label: '删除', size: 'compact' })));
  }

  // 时间线片段。视频：缩略图胶片条 + 片段名；声音：片段名 + 波形；字幕：一行文字。
  function seeded(seed) { var s = 0; for (var i = 0; i < String(seed).length; i++) s = (s * 31 + String(seed).charCodeAt(i)) >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function Clip(p) {
    var kind = p.kind || 'video', width = p.width || 120, cls = cx('zc-clip', 'zc-clip-' + kind, p.selected && 'is-selected', p.dimmed && 'is-dimmed');
    if (kind === 'video') {
      var n = Math.max(1, Math.ceil(width / 96)), rnd = seeded(p.seed || p.label || 'v');
      var thumbs = p.thumbs || Array.from({ length: n }, function () { var hue = 190 + Math.floor(rnd() * 60), l = 22 + Math.floor(rnd() * 14); return 'linear-gradient(170deg, hsl(' + hue + ' 18% ' + (l + 18) + '%), hsl(' + hue + ' 22% ' + l + '%) 62%, hsl(' + (hue - 70) + ' 20% ' + (l - 6) + '%))'; });
      return h('span', { className: cls, style: { width: width } },
        h('span', { className: 'zc-film', 'aria-hidden': 'true' }, thumbs.map(function (bg, i) { return h('span', { key: i, className: 'zc-film-frame', style: { background: bg.indexOf('url(') === 0 || bg.indexOf('gradient') > -1 ? bg : 'center / cover url(' + bg + ')' } }); })),
        p.label ? h('span', { className: 'zc-clip-name' }, p.label) : null);
    }
    if (kind === 'audio') {
      var bars = Math.max(4, Math.floor((width - 8) / 3)), r = seeded(p.seed || p.label || 'a'), env = 0.5;
      var rects = [];
      for (var k = 0; k < bars; k++) { env = Math.min(1, Math.max(0.15, env + (r() - 0.5) * 0.35)); var hgt = Math.max(2, Math.round(env * (0.55 + r() * 0.45) * 26)); rects.push(h('rect', { key: k, x: 4 + k * 3, y: 30 - hgt / 2, width: 2, height: hgt, rx: 1 })); }
      return h('span', { className: cls, style: { width: width } },
        p.label ? h('span', { className: 'zc-clip-name' }, p.label) : null,
        h('svg', { className: 'zc-wave', width: width, height: 48, viewBox: '0 0 ' + width + ' 48', 'aria-hidden': 'true' }, rects));
    }
    return h('span', { className: cls, style: { width: width } }, p.label);
  }

  window.ZsirCut = Object.assign(window.ZsirCut || {}, { Icon: Icon, Button: Button, IconButton: IconButton, Tabs: Tabs, Switch: Switch, StatusPill: StatusPill, Kbd: Kbd,
    DecisionCard: DecisionCard, DecisionProgress: DecisionProgress, StepRow: StepRow, FileIcon: FileIcon, DestinationCard: DestinationCard, SubtitleRow: SubtitleRow, Clip: Clip });
})();
