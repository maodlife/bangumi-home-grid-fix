// ==UserScript==
// @name         Bangumi 首页跳看进度格子修正
// @namespace    https://bgm.tv/
// @version      0.1.0
// @description  让手动启用的首页条目从“最高已看正片”开始显示章节格子，适合跳着观看的长篇条目。
// @author       Codex
// @match        https://bgm.tv/
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  if (location.origin !== 'https://bgm.tv' || location.pathname !== '/') {
    return;
  }

  const STORAGE_KEY = 'bangumi-home-grid-fix:enabled-subjects';
  const CONTROL_CLASS = 'bghgf-control';
  const TOGGLE_CLASS = 'bghgf-toggle';

  const originalPanelStates = new WeakMap();
  const runtimeStates = new Map();
  const episodeRequests = new Map();

  addStyles();

  const panels = Array.from(
    document.querySelectorAll('#cloumnSubjectInfo .infoWrapper[id^="subjectPanel_"]'),
  );

  for (const panel of panels) {
    const subjectId = getSubjectId(panel);
    if (!subjectId) {
      continue;
    }

    originalPanelStates.set(panel, capturePanelState(panel));
    addToggleControls(panel, subjectId);

    if (isSubjectEnabled(subjectId)) {
      void applyCorrection(panel, subjectId);
    }
  }

  function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .${CONTROL_CLASS} {
        margin-left: .35em;
        white-space: nowrap;
      }

      .${TOGGLE_CLASS}[aria-disabled="true"] {
        cursor: wait;
        opacity: .65;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  function getSubjectId(panel) {
    const match = panel.id.match(/^subjectPanel_(\d+)$/);
    return match?.[1] ?? null;
  }

  function readEnabledSubjects() {
    try {
      const value = GM_getValue(STORAGE_KEY, {});
      return value && typeof value === 'object' ? value : {};
    } catch (error) {
      console.warn('[Bangumi 格子修正] 无法读取设置，将使用空设置。', error);
      return {};
    }
  }

  function isSubjectEnabled(subjectId) {
    return readEnabledSubjects()[subjectId] === true;
  }

  function setSubjectEnabled(subjectId, enabled) {
    const subjects = readEnabledSubjects();

    if (enabled) {
      subjects[subjectId] = true;
    } else {
      delete subjects[subjectId];
    }

    GM_setValue(STORAGE_KEY, subjects);
  }

  function addToggleControls(panel, subjectId) {
    const hosts = [
      panel.querySelector('.header h3'),
      panel.querySelector('.tinyHeader'),
    ].filter(Boolean);

    for (const host of hosts) {
      const wrapper = document.createElement('small');
      wrapper.className = `progress_percent_text ${CONTROL_CLASS}`;

      const toggle = document.createElement('a');
      toggle.href = 'javascript:void(0);';
      toggle.className = `l ${TOGGLE_CLASS}`;
      toggle.dataset.subjectId = subjectId;
      toggle.textContent = '[修正格子]';
      toggle.title = '从最高已看正片开始显示章节格子';
      toggle.addEventListener('click', (event) => {
        void handleToggleClick(event, panel, subjectId);
      });

      wrapper.appendChild(toggle);
      host.appendChild(wrapper);
    }
  }

  async function handleToggleClick(event, panel, subjectId) {
    event.preventDefault();

    const runtime = runtimeStates.get(subjectId);
    if (runtime?.phase === 'loading') {
      return;
    }

    if (isSubjectEnabled(subjectId) && runtime?.phase === 'applied') {
      setSubjectEnabled(subjectId, false);
      location.reload();
      return;
    }

    setSubjectEnabled(subjectId, true);
    await applyCorrection(panel, subjectId);
  }

  async function applyCorrection(panel, subjectId) {
    setRuntimePhase(subjectId, 'loading');
    setToggleState(panel, '[正在修正…]', {
      disabled: true,
      title: '正在读取完整章节列表',
    });

    try {
      const episodes = await loadMainEpisodes(subjectId);
      const watchedEpisodes = episodes.filter((episode) => episode.watched);

      if (watchedEpisodes.length === 0) {
        setRuntimePhase(subjectId, 'applied', { episodes });
        setToggleState(panel, '[恢复原始]', {
          title: '没有找到已看正片；点击可关闭自动修正',
        });
        return;
      }

      const anchor = watchedEpisodes.reduce((highest, episode) => (
        episode.sequence > highest.sequence ? episode : highest
      ));
      const anchorIndex = episodes.findIndex((episode) => episode.id === anchor.id);

      if (anchorIndex < 0) {
        throw new Error('无法在正片列表中定位最高已看章节');
      }

      const slotCount = getGridSlots(panel).length;
      if (slotCount === 0) {
        throw new Error('当前条目没有可复用的章节格子');
      }

      const runtime = {
        anchorId: anchor.id,
        anchorIndex,
        episodes,
        initialSlotCount: slotCount,
        lastObservedOriginalCount: readOriginalProgressCount(panel),
        observer: null,
        pendingWatchedId: null,
        phase: 'applied',
        subjectId,
      };

      runtimeStates.set(subjectId, runtime);
      installProgressTracking(panel, runtime);
      renderCorrectedPanel(panel, runtime);

      setToggleState(panel, '[恢复原始]', {
        title: `当前从 ep.${formatSequence(anchor.sequenceLabel)} 开始显示；点击恢复 Bangumi 原始逻辑`,
      });
    } catch (error) {
      runtimeStates.get(subjectId)?.observer?.disconnect();
      restorePanelState(panel);
      setRuntimePhase(subjectId, 'error', { error });
      setToggleState(panel, '[修正失败，重试]', {
        title: error instanceof Error ? error.message : String(error),
      });
      console.warn(`[Bangumi 格子修正] 条目 ${subjectId} 修正失败。`, error);
    }
  }

  async function loadMainEpisodes(subjectId) {
    if (!episodeRequests.has(subjectId)) {
      const request = fetch(new URL(`/subject/${subjectId}/ep`, location.origin), {
        credentials: 'same-origin',
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`章节页请求失败（HTTP ${response.status}）`);
          }

          const html = await response.text();
          const parsed = new DOMParser().parseFromString(html, 'text/html');
          const episodes = extractMainEpisodes(parsed);

          if (episodes.length === 0) {
            throw new Error('没有从章节页解析到正片');
          }

          return episodes;
        })
        .catch((error) => {
          episodeRequests.delete(subjectId);
          throw error;
        });

      episodeRequests.set(subjectId, request);
    }

    return episodeRequests.get(subjectId);
  }

  function extractMainEpisodes(parsedDocument) {
    const seenEpisodeIds = new Set();
    const episodes = [];

    for (const link of parsedDocument.querySelectorAll('a[href^="/ep/"]')) {
      const href = link.getAttribute('href') ?? '';
      const hrefMatch = href.match(/^\/ep\/(\d+)$/);
      if (!hrefMatch || seenEpisodeIds.has(hrefMatch[1])) {
        continue;
      }

      const label = link.textContent?.trim() ?? '';
      const labelMatch = label.match(/^(\d+(?:\.\d+)?)\.(.+)$/);
      if (!labelMatch) {
        continue;
      }

      const item = link.closest('li');
      if (!item) {
        continue;
      }

      const id = hrefMatch[1];
      const sequence = Number(labelMatch[1]);
      if (!Number.isFinite(sequence)) {
        continue;
      }

      seenEpisodeIds.add(id);
      episodes.push({
        aired: item.querySelector('.epAirStatus .Air') !== null,
        href,
        id,
        sequence,
        sequenceLabel: labelMatch[1],
        title: labelMatch[2].trim(),
        watched: item.querySelector('.statusWatched') !== null,
      });
    }

    return episodes.sort((left, right) => (
      left.sequence - right.sequence || Number(left.id) - Number(right.id)
    ));
  }

  function renderCorrectedPanel(panel, runtime) {
    runtime.observer?.disconnect();

    const slots = getGridSlots(panel);
    if (slots.length === 0) {
      throw new Error('章节格子已从页面中消失');
    }

    const visibleEpisodes = runtime.episodes.slice(
      runtime.anchorIndex,
      runtime.anchorIndex + runtime.initialSlotCount,
    );

    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      const episode = visibleEpisodes[index];

      if (!episode) {
        slot.item.style.display = 'none';
        continue;
      }

      slot.item.style.display = '';
      updateGridLink(slot.link, episode, runtime.subjectId);
    }

    const watchedEpisodes = runtime.episodes.filter((episode) => episode.watched);
    const highestWatched = watchedEpisodes.reduce(
      (highest, episode) => (
        !highest || episode.sequence > highest.sequence ? episode : highest
      ),
      null,
    );
    const watchedCount = watchedEpisodes.length;

    updateProgressSummary(panel, watchedCount, highestWatched);
    updateNextEpisodeActions(panel, runtime, highestWatched);

    if (runtime.observer) {
      runtime.observer.observe(panel, {
        attributeFilter: ['class', 'ep_id'],
        attributes: true,
        childList: true,
        subtree: true,
      });
    }
  }

  function getGridSlots(panel) {
    const list = panel.querySelector('.epGird ul.prg_list');
    if (!list) {
      return [];
    }

    return Array.from(list.children)
      .filter((item) => item.tagName === 'LI')
      .map((item) => ({ item, link: item.querySelector('a') }))
      .filter((slot) => slot.link);
  }

  function updateGridLink(link, episode, subjectId) {
    link.setAttribute('href', episode.href);
    link.id = `prg_${episode.id}`;
    link.className = `load-epinfo ${
      episode.watched ? 'epBtnWatched' : episode.aired ? 'epBtnAir' : 'epBtnNA'
    }`;
    link.title = `ep.${episode.sequenceLabel} ${episode.title}`;
    link.setAttribute('rel', `#prginfo_${episode.id}`);
    link.setAttribute('subject_id', subjectId);
    link.textContent = formatSequence(episode.sequenceLabel);
  }

  function updateProgressSummary(panel, watchedCount, highestWatched) {
    if (!highestWatched) {
      return;
    }

    const summary = `已看 ${watchedCount} · 最高 ${highestWatched.sequenceLabel}`;
    const tinySummary = panel.querySelector('.tinyHeader #prgsPercentNum');
    const fullSummary = panel.querySelector('.header .progress .inner small');
    const subjectId = getSubjectId(panel);
    const listSummary = subjectId
      ? document.querySelector(
        `#prgSubjectList a.subjectItem.title[href="/subject/${subjectId}"] `
        + 'small.progress_percent_text',
      )
      : null;

    if (tinySummary) {
      tinySummary.textContent = `[${summary}]`;
    }
    if (fullSummary) {
      fullSummary.textContent = summary;
    }
    if (listSummary) {
      listSummary.textContent = `[${summary}]`;
    }
  }

  function updateNextEpisodeActions(panel, runtime, highestWatched) {
    const actions = panel.querySelectorAll(
      '.header a.prgCheckIn, .tinyHeader a.prgCheckIn',
    );
    if (actions.length === 0 || !highestWatched) {
      return;
    }

    const highestIndex = runtime.episodes.findIndex(
      (episode) => episode.id === highestWatched.id,
    );
    const nextEpisode = runtime.episodes
      .slice(highestIndex + 1)
      .find((episode) => !episode.watched);

    for (const action of actions) {
      if (!nextEpisode) {
        action.removeAttribute('ep_id');
        action.setAttribute('href', `/subject/${runtime.subjectId}/ep`);
        action.textContent = '已到最新';
        continue;
      }

      action.setAttribute('href', 'javascript:void(0);');
      action.setAttribute('ep_id', nextEpisode.id);
      action.setAttribute(
        'data-original-title',
        `<small>标记 ep.${nextEpisode.sequenceLabel} 为看过</small>`,
      );

      if (action.closest('.header')) {
        action.innerHTML = `ep.${escapeHtml(nextEpisode.sequenceLabel)} <span>看过</span>`;
      } else {
        action.textContent = `ep.${nextEpisode.sequenceLabel} 看过`;
      }
    }
  }

  function installProgressTracking(panel, runtime) {
    panel.addEventListener(
      'click',
      (event) => {
        const action = event.target.closest?.('a.prgCheckIn[ep_id]');
        if (!action || !panel.contains(action)) {
          return;
        }
        runtime.pendingWatchedId = action.getAttribute('ep_id');
      },
      true,
    );

    runtime.observer = new MutationObserver(() => {
      const originalCount = readOriginalProgressCount(panel);

      for (const watchedLink of panel.querySelectorAll(
        '.prg_list a.epBtnWatched[id^="prg_"]',
      )) {
        const episodeId = watchedLink.id.replace(/^prg_/, '');
        const episode = runtime.episodes.find((candidate) => candidate.id === episodeId);
        if (episode) {
          episode.watched = true;
          if (runtime.pendingWatchedId === episodeId) {
            runtime.pendingWatchedId = null;
          }
        }
      }

      const pendingEpisode = runtime.episodes.find(
        (episode) => episode.id === runtime.pendingWatchedId,
      );
      if (
        pendingEpisode
        && originalCount !== null
        && runtime.lastObservedOriginalCount !== null
        && originalCount > runtime.lastObservedOriginalCount
      ) {
        pendingEpisode.watched = true;
        runtime.pendingWatchedId = null;
      }
      if (originalCount !== null) {
        runtime.lastObservedOriginalCount = originalCount;
      }

      try {
        renderCorrectedPanel(panel, runtime);
      } catch (error) {
        runtime.observer?.disconnect();
        restorePanelState(panel);
        setRuntimePhase(runtime.subjectId, 'error', { error });
        setToggleState(panel, '[修正失败，重试]', {
          title: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  function readOriginalProgressCount(panel) {
    const text = panel.querySelector('.tinyHeader #prgsPercentNum')?.textContent ?? '';
    const match = text.match(/^\[(\d+)\s*\//);
    return match ? Number(match[1]) : null;
  }

  function formatSequence(sequenceLabel) {
    if (/^\d$/.test(sequenceLabel)) {
      return `0${sequenceLabel}`;
    }
    return sequenceLabel;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function capturePanelState(panel) {
    const states = [];

    for (const slot of getGridSlots(panel)) {
      states.push(
        captureElementState(slot.item, false),
        captureElementState(slot.link),
      );
    }

    for (const element of panel.querySelectorAll(
        '.tinyHeader #prgsPercentNum, .header .progress .inner small, '
        + '.header a.prgCheckIn, .tinyHeader a.prgCheckIn',
    )) {
      states.push(captureElementState(element));
    }

    const subjectId = getSubjectId(panel);
    const listSummary = subjectId
      ? document.querySelector(
        `#prgSubjectList a.subjectItem.title[href="/subject/${subjectId}"] `
        + 'small.progress_percent_text',
      )
      : null;
    if (listSummary) {
      states.push(captureElementState(listSummary));
    }

    return states;
  }

  function captureElementState(element, includeInnerHtml = true) {
    return {
      attributes: Array.from(element.attributes, ({ name, value }) => ({
        name,
        value,
      })),
      element,
      innerHTML: includeInnerHtml ? element.innerHTML : null,
    };
  }

  function restorePanelState(panel) {
    const states = originalPanelStates.get(panel) ?? [];

    for (const state of states) {
      const { element } = state;
      for (const attribute of Array.from(element.attributes)) {
        element.removeAttribute(attribute.name);
      }
      for (const attribute of state.attributes) {
        element.setAttribute(attribute.name, attribute.value);
      }
      if (state.innerHTML !== null) {
        element.innerHTML = state.innerHTML;
      }
    }
  }

  function setRuntimePhase(subjectId, phase, extra = {}) {
    const previous = runtimeStates.get(subjectId) ?? {};
    runtimeStates.set(subjectId, { ...previous, ...extra, phase });
  }

  function setToggleState(panel, text, { disabled = false, title = '' } = {}) {
    for (const toggle of panel.querySelectorAll(`.${TOGGLE_CLASS}`)) {
      toggle.textContent = text;
      toggle.title = title;
      toggle.setAttribute('aria-disabled', String(disabled));
    }
  }
})();
