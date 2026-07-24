// ==UserScript==
// @name         Bangumi 首页跳看进度格子修正
// @namespace    https://bgm.tv/
// @version      0.1.3
// @description  让手动启用的首页条目从“最高已看正片”开始显示章节格子，适合跳着观看的长篇条目。
// @author       Codex
// @match        https://bgm.tv/
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
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
  const TOOLTIP_RETRY_LIMIT = 50;
  const TOOLTIP_RETRY_DELAY = 100;

  const originalPanelStates = new WeakMap();
  const runtimeStates = new Map();
  const episodeRequests = new Map();
  const pageWindow = typeof unsafeWindow === 'object' ? unsafeWindow : window;
  let activeTooltipLink = null;
  let tooltipTitleObserver = null;

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
        tooltipRetryCount: 0,
        tooltipRetryTimer: null,
        tooltipTemplates: captureTooltipTemplates(panel),
      };

      runtimeStates.set(subjectId, runtime);
      installProgressTracking(panel, runtime);
      renderCorrectedPanel(panel, runtime);

      setToggleState(panel, '[恢复原始]', {
        title: `当前从 ep.${formatSequence(anchor.sequenceLabel)} 开始显示；点击恢复 Bangumi 原始逻辑`,
      });
    } catch (error) {
      const runtime = runtimeStates.get(subjectId);
      runtime?.observer?.disconnect();
      cleanupCorrectedTooltips(panel, runtime);
      restorePanelState(panel);
      rebindOriginalTooltips(panel);
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
        airDate: extractEpisodeMetadata(item, /\u9996\u64ad\s*[:\uff1a]\s*([^/]+)/),
        commentCount: extractEpisodeMetadata(item, /\u8ba8\u8bba\s*[:\uff1a]\s*\+?(\d+)/),
        duration: extractEpisodeMetadata(item, /\u65f6\u957f\s*[:\uff1a]\s*([^/]+)/),
        href,
        id,
        sequence,
        sequenceLabel: labelMatch[1],
        status: readEpisodeStatus(item),
        subtitle: (item.querySelector('h6 > span.tip')?.textContent ?? '')
          .replace(/^\s*\/\s*/, '')
          .trim(),
        title: labelMatch[2].trim(),
        watched: item.querySelector('.statusWatched') !== null,
      });
    }

    return episodes.sort((left, right) => (
      left.sequence - right.sequence || Number(left.id) - Number(right.id)
    ));
  }

  function extractEpisodeMetadata(item, pattern) {
    const text = Array.from(item.querySelectorAll('small.grey'))
      .map((element) => element.textContent?.trim() ?? '')
      .join(' / ');
    return text.match(pattern)?.[1]?.trim() ?? '';
  }

  function readEpisodeStatus(item) {
    if (item.querySelector('.statusWatched')) {
      return 'watched';
    }
    if (item.querySelector('.statusQueue')) {
      return 'queue';
    }
    if (item.querySelector('.statusDrop')) {
      return 'drop';
    }
    return 'none';
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
      const tooltipSelector = ensureEpisodeTooltip(runtime, index, episode);
      const tooltipReady = tooltipSelector !== null;
      slot.link.dataset.bghgfTooltipReady = String(tooltipReady);
      if (tooltipSelector) {
        slot.link.setAttribute('rel', tooltipSelector);
      } else {
        disableGridTooltip(slot.link);
      }
    }

    refreshCorrectedTooltips(panel, runtime);

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

  function captureTooltipTemplates(panel) {
    return getGridSlots(panel).map(({ link }) => {
      const selector = link.getAttribute('rel') ?? '';
      const episodeId = selector.match(/^#prginfo_(\d+)$/)?.[1] ?? null;
      const node = episodeId ? document.getElementById(`prginfo_${episodeId}`) : null;
      const statusAction = node?.querySelector('.epStatusTool a[href*="gh="]') ?? null;

      return {
        appliedEpisodeId: null,
        episodeId,
        formhash: extractFormhash(statusAction?.getAttribute('href') ?? ''),
        node,
        originalAttributes: node
          ? Array.from(node.attributes, ({ name, value }) => ({ name, value }))
          : [],
        originalInnerHTML: node?.innerHTML ?? '',
        selector,
        statusActionTemplate: statusAction?.cloneNode(false) ?? null,
      };
    });
  }

  function extractFormhash(href) {
    try {
      return new URL(href, location.origin).searchParams.get('gh') ?? '';
    } catch {
      return '';
    }
  }

  function getTooltipTemplate(runtime, index) {
    const primary = runtime.tooltipTemplates[index];
    if (!primary?.node || !primary.episodeId || !primary.selector) {
      return null;
    }

    const fallback = runtime.tooltipTemplates.find((template) => (
      template.node && template.formhash && template.statusActionTemplate
    ));

    return {
      ...primary,
      formhash: primary.formhash || fallback?.formhash || '',
      source: primary,
      statusActionTemplate: primary.statusActionTemplate
        ?? fallback?.statusActionTemplate
        ?? null,
    };
  }

  function ensureEpisodeTooltip(runtime, index, episode) {
    const template = getTooltipTemplate(runtime, index);
    if (!template?.node || !template.episodeId || !template.selector) {
      return null;
    }

    if (template.source.appliedEpisodeId !== episode.id) {
      template.node.innerHTML = template.source.originalInnerHTML;
      rewriteEpisodeReferences(template.node, template.episodeId, episode.id);
      template.source.appliedEpisodeId = episode.id;
    }

    if (!updateGeneratedTooltip(template.node, episode, template)) {
      return null;
    }

    return template.selector;
  }

  function rewriteEpisodeReferences(root, oldEpisodeId, newEpisodeId) {
    // Keep the original local-content node id. Existing ClueTip instances have
    // already cached this selector, so reusing it preserves Bangumi's styling
    // and remains correct even before the explicit rebind finishes.
    for (const element of root.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        let value = attribute.value;
        value = value.replaceAll(`/ep/${oldEpisodeId}`, `/ep/${newEpisodeId}`);
        value = value.replaceAll(`_${oldEpisodeId}`, `_${newEpisodeId}`);
        value = value.replaceAll(`#prginfo_${oldEpisodeId}`, `#prginfo_${newEpisodeId}`);
        if (value !== attribute.value) {
          element.setAttribute(attribute.name, value);
        }
      }
    }
  }

  function updateGeneratedTooltip(tooltip, episode, template) {
    const titleLink = Array.from(tooltip.querySelectorAll('a[href]')).find((link) => {
      try {
        const url = new URL(link.getAttribute('href'), location.origin);
        return url.pathname === episode.href && !url.hash;
      } catch {
        return false;
      }
    });
    if (titleLink) {
      titleLink.textContent = `ep.${episode.sequenceLabel} ${episode.title}`;
    }
    const discussionLink = Array.from(tooltip.querySelectorAll('a[href]')).find((link) => {
      try {
        const url = new URL(link.getAttribute('href'), location.origin);
        return url.pathname === episode.href && url.hash === '#comment_list';
      } catch {
        return false;
      }
    });
    if (discussionLink && /\d/.test(discussionLink.textContent ?? '')) {
      discussionLink.textContent = (discussionLink.textContent ?? '').replace(
        /\+?\d+/,
        episode.commentCount ? `+${episode.commentCount}` : '+0',
      );
    }
    updateTooltipMetadata(tooltip, episode);
    return rebuildEpisodeStatusTool(tooltip, episode, template);
  }

  function updateTooltipMetadata(tooltip, episode) {
    const walker = document.createTreeWalker(tooltip, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    for (const textNode of textNodes) {
      if (textNode.parentElement?.closest('.epStatusTool')) {
        continue;
      }

      let text = textNode.textContent ?? '';
      text = replaceTooltipValue(
        text,
        /(\u4e2d\u6587\u6807\u9898\s*[:\uff1a]\s*)[^/\r\n]+/,
        episode.subtitle || '-',
      );
      text = replaceTooltipValue(
        text,
        /(\u9996\u64ad\s*[:\uff1a]\s*)[^/\r\n]+/,
        episode.airDate || '-',
      );
      text = replaceTooltipValue(
        text,
        /(\u65f6\u957f\s*[:\uff1a]\s*)[^/\r\n]+/,
        episode.duration || '-',
      );
      text = replaceTooltipValue(
        text,
        /(\u8ba8\u8bba\s*[:\uff1a]\s*)\+?\d+/,
        episode.commentCount ? `+${episode.commentCount}` : '+0',
      );
      textNode.textContent = text;
    }
  }

  function replaceTooltipValue(text, pattern, value) {
    return text.replace(pattern, (match, prefix) => `${prefix}${value}`);
  }

  function rebuildEpisodeStatusTool(tooltip, episode, template) {
    const statusTool = tooltip.querySelector('.epStatusTool');
    if (!statusTool || !template.statusActionTemplate || !template.formhash) {
      return false;
    }

    statusTool.replaceChildren();

    const currentLabel = {
      drop: '\u629b\u5f03',
      queue: '\u60f3\u770b',
      watched: '\u770b\u8fc7',
    }[episode.status] ?? '';
    const current = document.createElement('p');
    current.id = `epBtnCu_${episode.id}`;
    if (currentLabel) {
      current.className = 'epBtnCu';
      current.textContent = currentLabel;
    }
    statusTool.appendChild(current);

    const actions = [
      { id: 'Watched', label: '\u770b\u8fc7', status: 'watched' },
      { id: 'WatchedTill', label: '\u770b\u5230', status: 'watched' },
      { id: 'Queue', label: '\u60f3\u770b', status: 'queue' },
      { id: 'Drop', label: '\u629b\u5f03', status: 'drop' },
      { id: 'remove', label: '\u64a4\u6d88', status: 'none' },
    ];

    for (const action of actions) {
      if (
        (episode.status === 'watched' && action.status === 'watched')
        || (episode.status === action.status && action.id !== 'WatchedTill')
        || (episode.status === 'none' && action.id === 'remove')
      ) {
        continue;
      }

      const link = template.statusActionTemplate.cloneNode(false);
      link.id = `${action.id}_${episode.id}`;
      link.href = `/subject/ep/${episode.id}/status/${
        action.id === 'remove' ? 'remove' : action.status
      }?gh=${encodeURIComponent(template.formhash)}`;
      link.textContent = action.label;
      bindEpisodeStatusLink(link);
      statusTool.appendChild(link);
    }

    return true;
  }

  function bindEpisodeStatusLink(link) {
    if (link.dataset.bghgfStatusBound === 'true') {
      return;
    }
    link.dataset.bghgfStatusBound = 'true';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const handler = pageWindow.chiiLib?.home?.epStatusClick;
      if (typeof handler === 'function') {
        handler.call(pageWindow.chiiLib.home, link);
      } else {
        location.assign(link.href);
      }
    });
  }

  function disableGridTooltip(link) {
    link.classList.remove('load-epinfo');
    link.removeAttribute('rel');
  }

  function refreshCorrectedTooltips(panel, runtime) {
    const links = getGridSlots(panel).map(({ link }) => link);
    const $ = pageWindow.jQuery;
    if (!$?.fn?.cluetip) {
      if (runtime.tooltipRetryTimer || runtime.tooltipRetryCount >= TOOLTIP_RETRY_LIMIT) {
        if (runtime.tooltipRetryCount >= TOOLTIP_RETRY_LIMIT) {
          for (const link of links) {
            disableGridTooltip(link);
          }
        }
        return;
      }

      runtime.tooltipRetryCount += 1;
      runtime.tooltipRetryTimer = setTimeout(() => {
        runtime.tooltipRetryTimer = null;
        refreshCorrectedTooltips(panel, runtime);
      }, TOOLTIP_RETRY_DELAY);
      return;
    }

    if (runtime.tooltipRetryTimer) {
      clearTimeout(runtime.tooltipRetryTimer);
      runtime.tooltipRetryTimer = null;
    }
    runtime.tooltipRetryCount = 0;

    for (const link of links) {
      try {
        link.title = link.dataset.bghgfFallbackTitle ?? '';
        if (link.dataset.bghgfTooltipReady === 'true') {
          if (
            link.dataset.bghgfCustomTooltip !== 'true'
            && !reuseNativeClueTip($, link)
          ) {
            initializeClueTip($, link);
            bindTooltipTitleSync(link);
            link.dataset.bghgfCustomTooltip = 'true';
          }
        } else {
          if (link.dataset.bghgfCustomTooltip === 'true') {
            $(link).cluetip('destroy');
            delete link.dataset.bghgfCustomTooltip;
          }
          disableGridTooltip(link);
        }
      } catch (error) {
        disableGridTooltip(link);
        console.warn('[Bangumi grid fix] Tooltip initialization failed; using title fallback.', error);
      }
    }
  }

  function reuseNativeClueTip($, link) {
    // Bangumi's ClueTip 1.0.3 stores this under "thisInfo"; newer forks
    // commonly use "cluetip", so support both without rebinding either one.
    const clueTipData = $(link).data('thisInfo') ?? $(link).data('cluetip');
    if (!clueTipData || link.dataset.bghgfCustomTooltip === 'true') {
      return false;
    }

    // ClueTip caches the local-content selector and positioning offsets in its
    // event closure. Keeping that instance is what preserves Bangumi's exact
    // native placement. Its public data title is updated for mouse-out restore;
    // the already-cached visible heading is synchronized separately below.
    if (typeof clueTipData === 'object') {
      clueTipData.title = link.dataset.bghgfFallbackTitle ?? '';
    }
    link.dataset.bghgfNativeTooltip = 'true';
    bindTooltipTitleSync(link);
    return true;
  }

  function bindTooltipTitleSync(link) {
    if (link.dataset.bghgfTitleSyncBound === 'true') {
      return;
    }
    link.dataset.bghgfTitleSyncBound = 'true';

    const activate = () => {
      activeTooltipLink = link;
      ensureTooltipTitleObserver();
      syncVisibleTooltipTitle();
      for (const delay of [50, 150, 400]) {
        setTimeout(() => {
          if (activeTooltipLink === link) {
            syncVisibleTooltipTitle();
          }
        }, delay);
      }
    };
    const deactivate = () => {
      if (activeTooltipLink === link) {
        activeTooltipLink = null;
      }
    };

    link.addEventListener('mouseenter', activate);
    link.addEventListener('mouseleave', deactivate);
    link.addEventListener('focus', activate);
    link.addEventListener('blur', deactivate);
  }

  function ensureTooltipTitleObserver() {
    if (tooltipTitleObserver || !document.body) {
      return;
    }

    tooltipTitleObserver = new MutationObserver(() => {
      if (
        activeTooltipLink
        && !activeTooltipLink.matches(':hover')
        && document.activeElement !== activeTooltipLink
      ) {
        activeTooltipLink = null;
      }
      syncVisibleTooltipTitle();
    });
    tooltipTitleObserver.observe(document.getElementById('cluetip') ?? document.body, {
      childList: true,
      subtree: true,
    });
  }

  function syncVisibleTooltipTitle() {
    const title = activeTooltipLink?.dataset.bghgfFallbackTitle;
    if (!title) {
      return;
    }

    const titleElement = document.querySelector(
      '#cluetip-title, #cluetip .cluetip-title',
    );
    if (!titleElement) {
      return;
    }

    const textNodes = Array.from(titleElement.childNodes).filter(
      (node) => node.nodeType === Node.TEXT_NODE,
    );
    const titleNode = textNodes[0] ?? document.createTextNode('');
    if (textNodes.length === 0) {
      titleElement.insertBefore(titleNode, titleElement.firstChild);
    }
    if (titleNode.nodeValue !== title) {
      titleNode.nodeValue = title;
    }
    for (const extraNode of textNodes.slice(1)) {
      extraNode.nodeValue = '';
    }
  }

  function initializeClueTip($, link) {
    const tinyMode = link.closest('.infoWrapper')?.classList.contains('tinyMode') === true;
    $(link).cluetip({
      arrows: true,
      closePosition: 'title',
      closeText: 'X',
      cluezIndex: 79,
      cursor: 'pointer',
      dropShadow: false,
      escapeTitle: true,
      leftOffset: tinyMode ? 0 : -5,
      local: true,
      mouseOutClose: true,
      positionBy: 'fixed',
      sticky: true,
      topOffset: tinyMode ? 23 : 29,
    });
  }

  function cleanupCorrectedTooltips(panel, runtime) {
    if (!runtime) {
      return;
    }
    if (runtime.tooltipRetryTimer) {
      clearTimeout(runtime.tooltipRetryTimer);
      runtime.tooltipRetryTimer = null;
    }

    const $ = pageWindow.jQuery;
    if ($?.fn?.cluetip) {
      for (const { link } of getGridSlots(panel)) {
        if (link.dataset.bghgfNativeTooltip === 'true') {
          delete link.dataset.bghgfNativeTooltip;
          continue;
        }
        try {
          $(link).cluetip('destroy');
        } catch {
          // The link may not have received a ClueTip instance yet.
        }
      }
    }

    const restoredNodes = new Set();
    for (const template of runtime.tooltipTemplates ?? []) {
      if (!template.node || restoredNodes.has(template.node)) {
        continue;
      }
      restoredNodes.add(template.node);
      for (const attribute of Array.from(template.node.attributes)) {
        template.node.removeAttribute(attribute.name);
      }
      for (const attribute of template.originalAttributes ?? []) {
        template.node.setAttribute(attribute.name, attribute.value);
      }
      template.node.innerHTML = template.originalInnerHTML;
      for (const action of template.node.querySelectorAll('.epStatusTool a')) {
        bindEpisodeStatusLink(action);
      }
      template.appliedEpisodeId = null;
    }
  }

  function rebindOriginalTooltips(panel) {
    setTimeout(() => {
      const $ = pageWindow.jQuery;
      if (!$?.fn?.cluetip) {
        return;
      }
      for (const { link } of getGridSlots(panel)) {
        const selector = link.getAttribute('rel');
        if (!selector || !document.querySelector(selector)) {
          continue;
        }
        try {
          $(link).cluetip('destroy');
          initializeClueTip($, link);
        } catch {
          // Bangumi can finish its own tooltip initialization afterwards.
        }
      }
    }, 0);
  }

  function updateGridLink(link, episode, subjectId) {
    link.setAttribute('href', episode.href);
    link.id = `prg_${episode.id}`;
    link.className = `load-epinfo ${
      getEpisodeGridClass(episode)
    }`;
    const tooltipTitle = `ep.${episode.sequenceLabel} ${episode.title}`;
    link.dataset.bghgfFallbackTitle = tooltipTitle;
    link.title = tooltipTitle;
    link.setAttribute('rel', `#prginfo_${episode.id}`);
    link.setAttribute('subject_id', subjectId);
    link.textContent = formatSequence(episode.sequenceLabel);
  }

  function getEpisodeGridClass(episode) {
    if (episode.status === 'watched' || episode.watched) {
      return 'epBtnWatched';
    }
    if (episode.status === 'queue') {
      return 'epBtnQueue';
    }
    if (episode.status === 'drop') {
      return 'epBtnDrop';
    }
    return episode.aired ? 'epBtnAir' : 'epBtnNA';
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

      for (const progressLink of panel.querySelectorAll(
        '.prg_list a[id^="prg_"]',
      )) {
        const episodeId = progressLink.id.replace(/^prg_/, '');
        const episode = runtime.episodes.find((candidate) => candidate.id === episodeId);
        if (!episode) {
          continue;
        }
        episode.status = readGridLinkStatus(progressLink);
        episode.watched = episode.status === 'watched';
        if (episode.watched && runtime.pendingWatchedId === episodeId) {
          runtime.pendingWatchedId = null;
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
        pendingEpisode.status = 'watched';
        runtime.pendingWatchedId = null;
      }
      if (originalCount !== null) {
        runtime.lastObservedOriginalCount = originalCount;
      }

      try {
        renderCorrectedPanel(panel, runtime);
      } catch (error) {
        runtime.observer?.disconnect();
        cleanupCorrectedTooltips(panel, runtime);
        restorePanelState(panel);
        rebindOriginalTooltips(panel);
        setRuntimePhase(runtime.subjectId, 'error', { error });
        setToggleState(panel, '[修正失败，重试]', {
          title: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  function readGridLinkStatus(link) {
    if (link.classList.contains('epBtnWatched')) {
      return 'watched';
    }
    if (link.classList.contains('epBtnQueue')) {
      return 'queue';
    }
    if (link.classList.contains('epBtnDrop')) {
      return 'drop';
    }
    return 'none';
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
