'use strict';

/* =========================================================
   Личная база знаний — иерархия, редактор, резервные копии
   ========================================================= */

const STORAGE_KEY = 'knowledge-base.notes.v1';
const SORT_STORAGE_KEY = 'knowledge-base.sort-by-updated';
const YANDEX_TOKEN_STORAGE_KEY = 'knowledge-base.yandex-oauth-token';
const MAX_CONTENT_LENGTH = 20000;
const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024;
const BACKUP_FORMAT = 'personal-knowledge-base';
const BACKUP_VERSION = 4;
const YANDEX_API_BASE = 'https://cloud-api.yandex.net/v1/disk';
const MAX_ATTACHMENT_SIZE = 1000 * 1000 * 1000;
const API_REQUEST_TIMEOUT = 30000;
const ATTACHMENT_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/bmp',
]);
const NOTE_UNDO_DURATION = 7000;

const sidebar = document.querySelector('#sidebar');
const sidebarToggle = document.querySelector('#sidebar-toggle');
const sidebarClose = document.querySelector('#sidebar-close');
const sidebarScrim = document.querySelector('#sidebar-scrim');
const brandHome = document.querySelector('#brand-home');
const newNoteButton = document.querySelector('#new-note');
const sortToggle = document.querySelector('#sort-by-updated');
const tree = document.querySelector('#tree');
const treeEmpty = document.querySelector('#tree-empty');
const notesCount = document.querySelector('#notes-count');
const breadcrumbs = document.querySelector('#breadcrumbs');
const homeView = document.querySelector('#home-view');
const homeNewNote = document.querySelector('#home-new-note');
const homeNotesTotal = document.querySelector('#home-notes-total');
const homeRootsTotal = document.querySelector('#home-roots-total');
const homeNestedTotal = document.querySelector('#home-nested-total');
const editorView = document.querySelector('#editor-view');
const editorMode = document.querySelector('#editor-mode');
const form = document.querySelector('#note-form');
const titleInput = document.querySelector('#note-title');
const titleError = document.querySelector('#note-title-error');
const updatedAtText = document.querySelector('#note-updated-at');
const contentInput = document.querySelector('#note-content');
const contentError = document.querySelector('#note-content-error');
const contentCount = document.querySelector('#note-content-count');
const parentSelect = document.querySelector('#note-parent');
const deleteButton = document.querySelector('#delete-note');
const saveNoteLabel = document.querySelector('#save-note-label');
const attachButton = document.querySelector('#attach-file');
const attachFileLabel = document.querySelector('#attach-file-label');
const attachSpinner = document.querySelector('#attach-spinner');
const attachmentInput = document.querySelector('#attachment-input');
const attachmentsList = document.querySelector('#attachments-list');
const attachmentsHint = document.querySelector('#attachments-hint');
const attachmentsEmpty = document.querySelector('#attachments-empty');
const settingsOpenButton = document.querySelector('#settings-open');
const settingsDialog = document.querySelector('#settings-dialog');
const settingsForm = document.querySelector('#settings-form');
const settingsCloseButton = document.querySelector('#settings-close');
const settingsClearButton = document.querySelector('#settings-clear');
const settingsError = document.querySelector('#settings-error');
const yandexTokenInput = document.querySelector('#yandex-token');
const exportButton = document.querySelector('#export-notes');
const importButton = document.querySelector('#import-notes');
const importFileInput = document.querySelector('#import-file');
const toast = document.querySelector('#toast');
const toastMessage = document.querySelector('#toast-message');
const toastAction = document.querySelector('#toast-action');

const chevronIcon = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6"/>
  </svg>
`;

const downloadIcon = `
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
       stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true">
    <path d="M12 4v11"/>
    <path d="m8 11 4 4 4-4"/>
    <path d="M5 20h14"/>
  </svg>
`;

const trashIcon = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
       stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true">
    <path d="M4 7h16"/>
    <path d="M9.5 7V4.8h5V7"/>
    <path d="M6.5 7l.8 12h9.4l.8-12"/>
    <path d="M10 11v4.5M14 11v4.5"/>
  </svg>
`;

let notes = [];
let selectedNoteId = null;
let isCreating = false;
let draftParentId = null;
let collapsedIds = new Set();
let sortByUpdated = false;
let isMobileSidebarOpen = false;
let toastTimerId = null;
let toastActionHandler = null;

let yandexToken = '';
let attachmentUploading = false;
let uploadProgress = 0;
let uploadingNoteId = null;
let appFolderReady = false;
let deleteLocked = false;

function debounce(callback, delay = 120) {
  let timeoutId = null;

  const debounced = (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      callback(...args);
    }, delay);
  };

  debounced.cancel = () => {
    window.clearTimeout(timeoutId);
    timeoutId = null;
  };

  return debounced;
}

/* =========================================================
   Данные
   ========================================================= */

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];

  const seenIds = new Set();

  return value
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const publicUrl =
        typeof entry.public_url === 'string' ? entry.public_url.trim() : '';

      if (!publicUrl || !isHttpsUrl(publicUrl)) return null;

      const directUrlRaw =
        typeof entry.direct_url === 'string' ? entry.direct_url.trim() : '';
      const directUrl =
        directUrlRaw && isHttpsUrl(directUrlRaw) ? directUrlRaw : '';

      let id =
        typeof entry.id === 'string' && entry.id.trim()
          ? entry.id.trim()
          : createId();

      while (seenIds.has(id)) {
        id = createId();
      }
      seenIds.add(id);

      const numericSize = Number(entry.size);

      return {
        id,
        name:
          typeof entry.name === 'string' && entry.name.trim()
            ? entry.name
            : 'Файл',
        type: typeof entry.type === 'string' ? entry.type : '',
        size: Number.isFinite(numericSize) ? Math.max(0, numericSize) : 0,
        public_url: publicUrl,
        direct_url: directUrl,
        remote_path:
          typeof entry.remote_path === 'string' &&
          entry.remote_path.startsWith('app:/')
            ? entry.remote_path
            : '',
        uploadedAt: normalizeTimestamp(entry.uploadedAt),
      };
    })
    .filter(Boolean);
}

function sanitizeNotes(list) {
  const cleaned = list.map((note) => ({
    ...note,
    parent_id: note.parent_id || null,
    updatedAt: normalizeTimestamp(note.updatedAt),
    attachments: normalizeAttachments(note.attachments),
  }));

  const ids = new Set(cleaned.map((note) => note.id));

  for (const note of cleaned) {
    if (note.parent_id === note.id || (note.parent_id && !ids.has(note.parent_id))) {
      note.parent_id = null;
    }
  }

  // Разрываем циклические связи, чтобы дерево всегда можно было отрисовать.
  const byId = new Map(cleaned.map((note) => [note.id, note]));

  for (const note of cleaned) {
    const path = new Set();
    let current = note;

    while (current) {
      if (path.has(current.id)) {
        current.parent_id = null;
        break;
      }

      path.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : null;
    }
  }

  return cleaned;
}

function readNotes() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const seenIds = new Set();

    const normalized = parsed
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => {
        let id =
          typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : createId();

        while (seenIds.has(id)) {
          id = createId();
        }
        seenIds.add(id);

        let parentId =
          typeof entry.parent_id === 'string' && entry.parent_id.trim()
            ? entry.parent_id.trim()
            : null;

        if (parentId === id) parentId = null;

        return {
          id,
          title: typeof entry.title === 'string' ? entry.title : '',
          content: typeof entry.content === 'string' ? entry.content : '',
          parent_id: parentId,
          updatedAt: normalizeTimestamp(entry.updatedAt),
          attachments: normalizeAttachments(entry.attachments),
        };
      })
      .filter((note) => note.title.trim() || note.content.trim());

    const cleanNotes = sanitizeNotes(normalized);

    // Переводим данные предыдущих версий на актуальную схему.
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanNotes));
    } catch (error) {
      console.warn('Не удалось обновить формат данных в LocalStorage.', error);
    }

    return cleanNotes;
  } catch (error) {
    console.warn('Не удалось прочитать заметки из LocalStorage.', error);
    return [];
  }
}

function persistNotes(nextNotes) {
  const cleanNotes = sanitizeNotes(nextNotes);

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanNotes));
    notes = cleanNotes;
    return true;
  } catch (error) {
    console.error('Не удалось сохранить заметки в LocalStorage.', error);
    return false;
  }
}

function getNoteById(id) {
  return notes.find((note) => note.id === id) || null;
}

function getNoteTitle(note) {
  return note.title.trim() || 'Без названия';
}

function getChildrenMap() {
  const map = new Map();

  for (const note of notes) {
    const key = note.parent_id || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(note);
  }

  return map;
}

function getDescendantIds(noteId) {
  const childrenMap = getChildrenMap();
  const descendants = new Set();
  const stack = [...(childrenMap.get(noteId) || [])];

  while (stack.length > 0) {
    const child = stack.pop();
    if (descendants.has(child.id)) continue;

    descendants.add(child.id);
    stack.push(...(childrenMap.get(child.id) || []));
  }

  return descendants;
}

function getNoteTrail(noteId) {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const trail = [];
  const visited = new Set();
  let current = byId.get(noteId);

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    trail.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : null;
  }

  return trail;
}

function flattenNotes() {
  const childrenMap = getChildrenMap();
  const visited = new Set();
  const result = [];

  const visit = (parentId, depth) => {
    const children = childrenMap.get(parentId) || [];

    for (const note of children) {
      if (visited.has(note.id)) continue;

      visited.add(note.id);
      result.push({ note, depth });
      visit(note.id, depth + 1);
    }
  };

  visit(null, 0);

  // Страховка на случай нестандартных данных: показываем оставшиеся заметки.
  for (const note of notes) {
    if (visited.has(note.id)) continue;

    visited.add(note.id);
    result.push({ note, depth: 0 });
    visit(note.id, 1);
  }

  return result;
}

function getNoteWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) return 'заметка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'заметки';
  return 'заметок';
}

function shorten(value, maximum = 42) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum).trimEnd()}…`
    : normalized;
}

function renderUpdatedAt(value, { creating = false } = {}) {
  updatedAtText.removeAttribute('datetime');

  if (creating) {
    updatedAtText.textContent = 'Только что создана';
    return;
  }

  const timestamp = normalizeTimestamp(value);
  if (!timestamp) {
    updatedAtText.textContent = 'Последнее изменение: —';
    return;
  }

  const date = new Date(timestamp);
  const pad = (part) => String(part).padStart(2, '0');
  const formatted = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} в ${pad(date.getHours())}:${pad(date.getMinutes())}`;

  updatedAtText.setAttribute('datetime', timestamp);
  updatedAtText.textContent = `Последнее изменение: ${formatted}`;
}

function readSortPreference() {
  try {
    return window.localStorage.getItem(SORT_STORAGE_KEY) === 'true';
  } catch (error) {
    console.warn('Не удалось прочитать настройку сортировки.', error);
    return false;
  }
}

function persistSortPreference() {
  try {
    window.localStorage.setItem(SORT_STORAGE_KEY, String(sortByUpdated));
  } catch (error) {
    console.warn('Не удалось сохранить настройку сортировки.', error);
  }
}

function updateSortToggle() {
  sortToggle.setAttribute('aria-pressed', String(sortByUpdated));
}

function compareNotesByUpdatedAt(first, second) {
  const firstTime = first.updatedAt ? Date.parse(first.updatedAt) : 0;
  const secondTime = second.updatedAt ? Date.parse(second.updatedAt) : 0;

  return (Number.isNaN(secondTime) ? 0 : secondTime) -
    (Number.isNaN(firstTime) ? 0 : firstTime);
}

/* =========================================================
   Дерево заметок
   ========================================================= */

function renderTree() {
  const scrollTop = tree.scrollTop;
  const hasNotes = notes.length > 0;

  notesCount.textContent = `${notes.length} ${getNoteWord(notes.length)}`;
  treeEmpty.hidden = hasNotes;
  tree.hidden = !hasNotes;
  tree.replaceChildren();

  if (hasNotes) {
    const childrenMap = getChildrenMap();

    if (sortByUpdated) {
      for (const children of childrenMap.values()) {
        children.sort(compareNotesByUpdatedAt);
      }
    }

    const visited = new Set();
    const rootList = createTreeList(null, childrenMap, 0, visited);

    if (rootList) tree.append(rootList);
  }

  tree.scrollTop = scrollTop;
  scrollActiveTreeLinkIntoView();
}

function scrollActiveTreeLinkIntoView() {
  const activeLink = tree.querySelector('.tree-link.is-active');
  if (!activeLink || activeLink.getClientRects().length === 0) return;

  const treeRect = tree.getBoundingClientRect();
  const linkRect = activeLink.getBoundingClientRect();

  if (linkRect.top < treeRect.top) {
    tree.scrollTop -= treeRect.top - linkRect.top + 8;
  } else if (linkRect.bottom > treeRect.bottom) {
    tree.scrollTop += linkRect.bottom - treeRect.bottom + 8;
  }
}

function createTreeList(parentId, childrenMap, depth, visited) {
  const children = childrenMap.get(parentId) || [];
  if (children.length === 0) return null;

  const list = document.createElement('ul');
  list.className = 'tree-list';

  for (const note of children) {
    if (visited.has(note.id)) continue;
    visited.add(note.id);

    const childNotes = childrenMap.get(note.id) || [];
    const hasChildren = childNotes.some((child) => !visited.has(child.id));
    const isExpanded = !collapsedIds.has(note.id);
    const title = getNoteTitle(note);

    const item = document.createElement('li');
    item.className = 'tree-item';

    const row = document.createElement('div');
    row.className = 'tree-row';

    if (hasChildren) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tree-toggle';
      toggle.dataset.action = 'toggle-branch';
      toggle.dataset.noteId = note.id;
      toggle.setAttribute('aria-expanded', String(isExpanded));
      toggle.setAttribute(
        'aria-label',
        `${isExpanded ? 'Свернуть' : 'Развернуть'} ветку «${title}»`,
      );
      toggle.innerHTML = chevronIcon;
      row.append(toggle);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'tree-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      row.append(spacer);
    }

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'tree-link';
    link.dataset.action = 'open-note';
    link.dataset.noteId = note.id;
    link.title = title;
    link.textContent = title;

    if (note.id === selectedNoteId) {
      link.classList.add('is-active');
      link.setAttribute('aria-current', 'page');
    }

    row.append(link);
    item.append(row);

    if (hasChildren) {
      const nestedList = createTreeList(note.id, childrenMap, depth + 1, visited);
      if (nestedList) {
        nestedList.hidden = collapsedIds.has(note.id);
        item.append(nestedList);
      }
    }

    list.append(item);
  }

  return list;
}

function findTreeToggle(noteId) {
  for (const toggle of tree.querySelectorAll('.tree-toggle')) {
    if (toggle.dataset.noteId === noteId) return toggle;
  }

  return null;
}

function findTreeLink(noteId) {
  for (const link of tree.querySelectorAll('.tree-link')) {
    if (link.dataset.noteId === noteId) return link;
  }

  return null;
}

function setBranchExpanded(noteId, expanded, toggle = findTreeToggle(noteId)) {
  if (expanded) {
    collapsedIds.delete(noteId);
  } else {
    collapsedIds.add(noteId);
  }

  if (!toggle) return;

  toggle.setAttribute('aria-expanded', String(expanded));

  const item = toggle.closest('.tree-item');
  const childList = item?.querySelector('.tree-list');
  if (childList) childList.hidden = !expanded;

  const title = item?.querySelector('.tree-link')?.textContent || 'заметку';
  toggle.setAttribute(
    'aria-label',
    `${expanded ? 'Свернуть' : 'Развернуть'} ветку «${title}»`,
  );
}

function toggleBranch(noteId, toggle) {
  if (!toggle) return;
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
  setBranchExpanded(noteId, !isExpanded, toggle);
}

function expandAncestors(noteId) {
  const trail = getNoteTrail(noteId);

  for (const ancestor of trail.slice(0, -1)) {
    if (!collapsedIds.has(ancestor.id)) continue;
    setBranchExpanded(ancestor.id, true);
  }
}

function syncTreeActiveState() {
  for (const link of tree.querySelectorAll('.tree-link')) {
    const isActive = link.dataset.noteId === selectedNoteId;
    link.classList.toggle('is-active', isActive);

    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
}

function updateTreeNoteTitle(noteId, title) {
  const link = findTreeLink(noteId);
  if (!link) return false;

  link.textContent = title;
  link.title = title;

  const toggle = findTreeToggle(noteId);
  if (toggle) {
    const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute(
      'aria-label',
      `${isExpanded ? 'Свернуть' : 'Развернуть'} ветку «${title}»`,
    );
  }

  return true;
}

/* =========================================================
   Хлебные крошки и главная
   ========================================================= */

function renderBreadcrumbs() {
  const fragment = document.createDocumentFragment();
  const onHome = !selectedNoteId && !isCreating;

  appendCrumb(fragment, 'Главная', { action: 'go-home', current: onHome });

  if (isCreating) {
    const parentTrail = draftParentId ? getNoteTrail(draftParentId) : [];

    for (const parent of parentTrail) {
      appendCrumbSeparator(fragment);
      appendCrumb(fragment, getNoteTitle(parent), {
        action: 'open-note',
        noteId: parent.id,
      });
    }

    appendCrumbSeparator(fragment);
    const current = document.createElement('span');
    current.className = 'crumb';
    current.setAttribute('aria-current', 'page');
    current.textContent = 'Новая заметка';
    fragment.append(current);
  } else if (selectedNoteId) {
    const trail = getNoteTrail(selectedNoteId);

    if (trail.length === 0) {
      const current = document.createElement('span');
      current.className = 'crumb';
      current.setAttribute('aria-current', 'page');
      current.textContent = 'Заметка не найдена';
      fragment.append(current);
    } else {
      trail.forEach((note, index) => {
        appendCrumbSeparator(fragment);
        appendCrumb(fragment, getNoteTitle(note), {
          action: 'open-note',
          noteId: note.id,
          current: index === trail.length - 1,
        });
      });
    }
  }

  breadcrumbs.replaceChildren(fragment);
}

function appendCrumb(fragment, label, { action = '', noteId = '', current = false } = {}) {
  const crumb = document.createElement('button');
  crumb.type = 'button';
  crumb.className = 'crumb';
  crumb.textContent = label;
  crumb.title = label;

  if (action) crumb.dataset.action = action;
  if (noteId) crumb.dataset.noteId = noteId;
  if (current) crumb.setAttribute('aria-current', 'page');

  fragment.append(crumb);
}

function appendCrumbSeparator(fragment) {
  const separator = document.createElement('span');
  separator.className = 'crumb-separator';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = '/';
  fragment.append(separator);
}

function renderHomeStats() {
  const childrenMap = getChildrenMap();
  const rootCount = notes.filter((note) => !note.parent_id).length;
  const parentCount = notes.filter((note) => (childrenMap.get(note.id) || []).length > 0).length;

  homeNotesTotal.textContent = String(notes.length);
  homeRootsTotal.textContent = String(rootCount);
  homeNestedTotal.textContent = String(parentCount);
}

function updateDocumentTitle() {
  if (isCreating) {
    document.title = 'Новая заметка — Личная база знаний';
    return;
  }

  const note = selectedNoteId ? getNoteById(selectedNoteId) : null;
  document.title = note
    ? `${getNoteTitle(note)} — Личная база знаний`
    : 'Личная база знаний';
}

function showHome() {
  selectedNoteId = null;
  isCreating = false;
  draftParentId = null;

  homeView.hidden = false;
  editorView.hidden = true;

  renderTree();
  renderBreadcrumbs();
  renderHomeStats();
  updateDocumentTitle();
  clearAttachmentsView('Пока нет вложений.');
  updateAttachmentControls();
  closeMobileSidebar({ restoreFocus: true });
  scrollToTop();
}

/* =========================================================
   Редактор
   ========================================================= */

function openNote(noteId) {
  const note = getNoteById(noteId);

  if (!note) {
    showHome();
    return;
  }

  selectedNoteId = note.id;
  isCreating = false;
  draftParentId = null;

  expandAncestors(note.id);
  homeView.hidden = true;
  editorView.hidden = false;

  fillEditor(note);
  renderBreadcrumbs();

  if (findTreeLink(note.id)) {
    syncTreeActiveState();
    scrollActiveTreeLinkIntoView();
  } else {
    renderTree();
  }

  updateDocumentTitle();
  closeMobileSidebar({ restoreFocus: true });
  scrollToTop();
}

function startCreatingNote(parentId = null) {
  selectedNoteId = null;
  isCreating = true;
  draftParentId = parentId && getNoteById(parentId) ? parentId : null;

  homeView.hidden = true;
  editorView.hidden = false;

  titleInput.value = '';
  contentInput.value = '';
  populateParentSelect(null, draftParentId);
  setEditorMode(true);
  debouncedContentCount.cancel();
  updateContentCount();
  renderUpdatedAt(null, { creating: true });
  resetAttachmentsForNewNote();
  clearFieldError(titleInput, titleError);
  clearFieldError(contentInput, contentError);

  renderBreadcrumbs();
  syncTreeActiveState();
  updateDocumentTitle();
  closeMobileSidebar({ restoreFocus: true });
  scrollToTop();

  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    titleInput.focus({ preventScroll: true });
  }
}

function fillEditor(note) {
  titleInput.value = note.title;
  contentInput.value = note.content;
  populateParentSelect(note.id, note.parent_id);
  setEditorMode(false);
  debouncedContentCount.cancel();
  updateContentCount();
  renderUpdatedAt(note.updatedAt);
  clearFieldError(titleInput, titleError);
  clearFieldError(contentInput, contentError);
  renderAttachmentsForNote(note);
  updateAttachmentControls();
}

function setEditorMode(creating) {
  editorMode.textContent = creating ? 'Новая заметка' : 'Редактирование';
  saveNoteLabel.textContent = creating ? 'Создать' : 'Сохранить';
  deleteButton.hidden = creating;
}

function populateParentSelect(currentNoteId, selectedParentId) {
  parentSelect.replaceChildren();

  const rootOption = document.createElement('option');
  rootOption.value = '';
  rootOption.textContent = 'Корень (без родителя)';
  parentSelect.append(rootOption);

  const blockedIds = new Set();

  if (currentNoteId) {
    blockedIds.add(currentNoteId);

    for (const id of getDescendantIds(currentNoteId)) {
      blockedIds.add(id);
    }
  }

  for (const { note, depth } of flattenNotes()) {
    const option = document.createElement('option');
    option.value = note.id;

    let label = `${'— '.repeat(depth)}${getNoteTitle(note)}`;

    if (blockedIds.has(note.id)) {
      label += note.id === currentNoteId ? ' (текущая)' : ' (вложенная)';
    }

    option.textContent = label;
    option.disabled = blockedIds.has(note.id);
    parentSelect.append(option);
  }

  const isValidSelection =
    selectedParentId &&
    !blockedIds.has(selectedParentId) &&
    Boolean(getNoteById(selectedParentId));

  parentSelect.value = isValidSelection ? selectedParentId : '';
}

function updateContentCount() {
  const current = contentInput.value.length.toLocaleString('ru-RU');
  const maximum = MAX_CONTENT_LENGTH.toLocaleString('ru-RU');
  contentCount.textContent = `${current} / ${maximum}`;
}

const debouncedContentCount = debounce(updateContentCount, 100);

function setFieldError(input, errorElement, message) {
  input.closest('.field')?.classList.add('field--invalid');
  input.setAttribute('aria-invalid', 'true');
  errorElement.textContent = message;
}

function clearFieldError(input, errorElement) {
  input.closest('.field')?.classList.remove('field--invalid');
  input.removeAttribute('aria-invalid');
  errorElement.textContent = '';
}

function handleSubmit(event) {
  event.preventDefault();

  if (attachmentUploading && uploadingNoteId === selectedNoteId) {
    showToast(
      'Дождитесь окончания загрузки файла. Сохранить заметку можно после завершения загрузки.',
      {
        type: 'error',
        duration: 6000,
      },
    );
    return;
  }

  const creating = isCreating;
  const title = titleInput.value.trim();
  const content = contentInput.value.trim();
  const titleIsValid = title.length > 0;

  if (!titleIsValid) {
    setFieldError(titleInput, titleError, 'Введите заголовок заметки.');
    titleInput.focus();
    return;
  }

  clearFieldError(titleInput, titleError);
  clearFieldError(contentInput, contentError);

  const selectedParent = parentSelect.value || null;
  const parentId =
    selectedParent && getNoteById(selectedParent) ? selectedParent : null;

  const currentNote = creating ? null : getNoteById(selectedNoteId);

  if (!creating && !currentNote) {
    showToast('Не удалось найти заметку. Обновите страницу.', {
      type: 'error',
      duration: 6000,
    });
    showHome();
    return;
  }

  if (!creating) {
    if (parentId === currentNote.id) {
      showToast('Заметка не может быть родителем самой себе.', {
        type: 'error',
        duration: 6000,
      });
      return;
    }

    if (parentId && getDescendantIds(currentNote.id).has(parentId)) {
      showToast('Нельзя переместить заметку внутрь её собственной ветки.', {
        type: 'error',
        duration: 6000,
      });
      return;
    }
  }

  const parentChanged =
    !creating && (currentNote.parent_id || null) !== (parentId || null);
  const savedAt = new Date().toISOString();

  let savedNote;

  if (creating) {
    savedNote = {
      id: createId(),
      title,
      content,
      parent_id: parentId,
      updatedAt: savedAt,
      attachments: [],
    };

    if (!persistNotes([...notes, savedNote])) {
      showToast('Не удалось сохранить заметку. Возможно, хранилище браузера заполнено.', {
        type: 'error',
        duration: 6000,
      });
      return;
    }
  } else {
    savedNote = {
      ...currentNote,
      title,
      content,
      parent_id: parentId,
      updatedAt: savedAt,
    };

    const nextNotes = notes.map((note) =>
      note.id === currentNote.id ? savedNote : note,
    );

    if (!persistNotes(nextNotes)) {
      showToast('Не удалось сохранить изменения. Возможно, хранилище браузера заполнено.', {
        type: 'error',
        duration: 6000,
      });
      return;
    }
  }

  selectedNoteId = savedNote.id;
  isCreating = false;
  draftParentId = null;

  expandAncestors(savedNote.id);

  const storedNote = getNoteById(savedNote.id) || savedNote;
  fillEditor(storedNote);

  if (creating || parentChanged || sortByUpdated) {
    renderTree();
  } else if (!updateTreeNoteTitle(storedNote.id, getNoteTitle(storedNote))) {
    renderTree();
  } else {
    syncTreeActiveState();
    scrollActiveTreeLinkIntoView();
  }

  renderBreadcrumbs();
  renderHomeStats();
  updateDocumentTitle();
  closeMobileSidebar({ restoreFocus: false });

  if (creating) {
    showToast('Заметка создана.');
  } else if (parentChanged) {
    showToast('Заметка перемещена в дереве.');
  } else {
    showToast('Изменения сохранены.');
  }
}

function deleteCurrentNote() {
  const note = getNoteById(selectedNoteId);
  if (!note || deleteLocked) return;

  deleteLocked = true;
  window.setTimeout(() => {
    deleteLocked = false;
  }, 500);

  const removedIndex = notes.findIndex((item) => item.id === note.id);
  const removedNote = { ...note };
  const childIds = notes
    .filter((item) => item.parent_id === note.id)
    .map((item) => item.id);
  const parentId = note.parent_id;

  const nextNotes = notes
    .filter((item) => item.id !== note.id)
    .map((item) =>
      item.parent_id === note.id ? { ...item, parent_id: parentId } : item,
    );

  if (!persistNotes(nextNotes)) {
    showToast('Не удалось удалить заметку. Попробуйте ещё раз.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  if (parentId && getNoteById(parentId)) {
    renderTree();
    openNote(parentId);
  } else {
    showHome();
  }

  const title = shorten(getNoteTitle(removedNote));
  const message =
    childIds.length > 0
      ? `Заметка «${title}» удалена, дочерние перемещены выше.`
      : `Заметка «${title}» удалена.`;

  showToast(message, {
    actionLabel: 'Отменить',
    duration: NOTE_UNDO_DURATION,
    onAction: () => {
      if (getNoteById(removedNote.id)) return;

      const restored = [...notes];
      restored.splice(Math.min(removedIndex, restored.length), 0, {
        ...removedNote,
      });

      const childIdSet = new Set(childIds);
      const withRestoredChildren = restored.map((item) =>
        childIdSet.has(item.id) ? { ...item, parent_id: removedNote.id } : item,
      );

      if (!persistNotes(withRestoredChildren)) {
        showToast('Не удалось восстановить заметку. Попробуйте ещё раз.', {
          type: 'error',
          duration: 6000,
        });
        return;
      }

      renderTree();
      openNote(removedNote.id);
      showToast('Заметка восстановлена.');
    },
  });
}

/* =========================================================
   Яндекс.Диск, настройки и вложения
   ========================================================= */

function readYandexToken() {
  try {
    return normalizeYandexToken(
      window.localStorage.getItem(YANDEX_TOKEN_STORAGE_KEY) || '',
    );
  } catch (error) {
    console.warn('Не удалось прочитать OAuth-токен Яндекс.Диска.', error);
    return '';
  }
}

function writeYandexToken(token) {
  try {
    if (token) {
      window.localStorage.setItem(YANDEX_TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(YANDEX_TOKEN_STORAGE_KEY);
    }
    return true;
  } catch (error) {
    console.warn('Не удалось сохранить OAuth-токен Яндекс.Диска.', error);
    return false;
  }
}

function normalizeYandexToken(value) {
  return String(value || '')
    .trim()
    .replace(/^OAuth\s+/i, '')
    .trim();
}

function setSettingsError(message = '') {
  settingsError.textContent = message;
  settingsError.hidden = !message;
}

function openSettings(message = '') {
  yandexTokenInput.value = yandexToken;
  settingsClearButton.disabled = !yandexToken;
  setSettingsError(message);

  if (!settingsDialog.open) {
    if (typeof settingsDialog.showModal === 'function') {
      settingsDialog.showModal();
    } else {
      settingsDialog.setAttribute('open', '');
    }
  }

  document.body.classList.add('settings-open');
  window.setTimeout(() => {
    if (settingsDialog.open) {
      yandexTokenInput.focus();
    }
  }, 0);
}

function closeSettings() {
  if (settingsDialog.open && typeof settingsDialog.close === 'function') {
    settingsDialog.close();
  } else {
    settingsDialog.removeAttribute('open');
  }

  document.body.classList.remove('settings-open');
  settingsOpenButton.focus();
}

function handleSettingsSubmit(event) {
  event.preventDefault();

  const token = normalizeYandexToken(yandexTokenInput.value);

  if (!token) {
    setSettingsError('Введите OAuth-токен Яндекс.Диска.');
    yandexTokenInput.focus();
    return;
  }

  if (!writeYandexToken(token)) {
    setSettingsError('Не удалось сохранить токен в localStorage.');
    return;
  }

  yandexToken = token;
  appFolderReady = false;
  setSettingsError('');
  settingsClearButton.disabled = false;
  refreshAttachmentsForCurrentNote();
  closeSettings();
  showToast('OAuth-токен сохранён.');
}

function handleClearYandexToken() {
  if (!writeYandexToken('')) {
    setSettingsError('Не удалось удалить токен из localStorage.');
    return;
  }

  yandexToken = '';
  appFolderReady = false;
  yandexTokenInput.value = '';
  setSettingsError('');
  settingsClearButton.disabled = true;
  refreshAttachmentsForCurrentNote();
  closeSettings();
  showToast('OAuth-токен удалён.');
}

function refreshAttachmentsForCurrentNote() {
  const note =
    !isCreating && selectedNoteId ? getNoteById(selectedNoteId) : null;

  if (note) {
    renderAttachmentsForNote(note);
  }

  updateAttachmentControls();
}

/* ---------- Яндекс.Диск API ---------- */

function sanitizeFileName(filename) {
  const translit = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'kh',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'shch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
    і: 'i',
    ї: 'yi',
    є: 'ye',
    ґ: 'g',
    ў: 'u',
  };

  const transliterate = (value) =>
    value
      .split('')
      .map((character) => {
        const lower = character.toLowerCase();
        return translit[lower] ?? lower;
      })
      .join('')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');

  const cleanPart = (value) =>
    transliterate(String(value || ''))
      .replace(/\s+/g, '_')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[-_]+|[-_]+$/g, '');

  const originalName = String(filename || 'file');
  const lastDot = originalName.lastIndexOf('.');
  const rawBase = lastDot > 0 ? originalName.slice(0, lastDot) : originalName;
  const rawExtension = lastDot > 0 ? originalName.slice(lastDot + 1) : '';

  const safeBase = cleanPart(rawBase).slice(0, 100) || 'file';
  const safeExtension = cleanPart(rawExtension)
    .replace(/[-_]/g, '')
    .slice(0, 10);

  return safeExtension ? `${safeBase}.${safeExtension}` : safeBase;
}

function createRemotePath(file) {
  const uniquePrefix = `${Date.now()}-${createId().slice(0, 8)}`;
  const safeName = sanitizeFileName(file.name);
  const encodedSafeName = encodeURIComponent(safeName);

  return `app:/${uniquePrefix}-${encodedSafeName}`;
}

async function createYandexApiError(response) {
  let detail = '';

  try {
    const data = await response.json();
    detail = [data.description, data.message, data.error]
      .find((value) => typeof value === 'string' && value.trim()) || '';
  } catch (error) {
    // Яндекс может вернуть пустой ответ или HTML при сетевой ошибке.
  }

  let message;

  if (response.status === 401) {
    message =
      'OAuth-токен недействителен или истёк. Вставьте новый токен в настройках.';
  } else if (response.status === 403) {
    message = 'Недостаточно прав для работы с Яндекс.Диском.';
  } else {
    message = detail || `Яндекс.Диск вернул ошибку ${response.status}.`;
  }

  const error = new Error(message);
  error.status = response.status;
  error.code =
    response.status === 401
      ? 'YANDEX_UNAUTHORIZED'
      : response.status === 403
        ? 'YANDEX_FORBIDDEN'
        : 'YANDEX_API';
  return error;
}

async function fetchWithTimeout(url, options = {}) {
  const controller =
    typeof window.AbortController === 'function'
      ? new window.AbortController()
      : null;

  const timeoutId = window.setTimeout(() => {
    if (controller) controller.abort();
  }, API_REQUEST_TIMEOUT);

  try {
    return await fetch(
      url,
      controller ? { ...options, signal: controller.signal } : options,
    );
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error(
        'Яндекс.Диск не ответил вовремя. Проверьте подключение к интернету и повторите попытку.',
      );
      timeoutError.code = 'YANDEX_TIMEOUT';
      throw timeoutError;
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function buildYandexApiUrl(endpoint, params) {
  // Кодируем значения ровно один раз: путь с кириллицей и пробелами
  // уходит в API как часть query-строки.
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join('&');

  return `${YANDEX_API_BASE}${endpoint}${query ? `?${query}` : ''}`;
}

async function ensureAppFolder(token) {
  if (appFolderReady) return;

  const checkUrl = buildYandexApiUrl('/resources', {
    path: 'app:/',
    fields: 'type',
  });

  let response;

  try {
    response = await fetchWithTimeout(checkUrl, {
      method: 'GET',
      headers: {
        Authorization: `OAuth ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    console.warn(
      'Не удалось проверить папку app:/ перед загрузкой. Продолжаем.',
      error,
    );
    return;
  }

  if (response.ok) {
    appFolderReady = true;
    return;
  }

  if (response.status === 401 || response.status === 403) {
    throw await createYandexApiError(response);
  }

  if (response.status !== 404) {
    console.warn(
      `Не удалось проверить папку app:/ (HTTP ${response.status}). Продолжаем загрузку.`,
    );
    return;
  }

  const createUrl = buildYandexApiUrl('/resources', {
    path: 'app',
  });

  let createResponse;

  try {
    createResponse = await fetchWithTimeout(createUrl, {
      method: 'PUT',
      headers: {
        Authorization: `OAuth ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  } catch (error) {
    console.warn(
      'Не удалось создать папку app. Продолжаем загрузку.',
      error,
    );
    return;
  }

  if (createResponse.ok || createResponse.status === 409) {
    appFolderReady = true;
    return;
  }

  if (createResponse.status === 401 || createResponse.status === 403) {
    throw await createYandexApiError(createResponse);
  }

  console.warn(
    `Не удалось создать папку app (HTTP ${createResponse.status}). Продолжаем загрузку.`,
  );
}

async function getYandexUploadUrl(token, remotePath) {
  const url = buildYandexApiUrl('/resources/upload', {
    path: remotePath,
    overwrite: 'true',
  });

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw await createYandexApiError(response);
  }

  const data = await response.json();
  if (!data || typeof data.href !== 'string' || !data.href) {
    throw new Error('Яндекс.Диск не вернул ссылку для загрузки файла.');
  }

  return data.href;
}

async function getYandexDirectUrl(token, remotePath) {
  const url = buildYandexApiUrl('/resources/download', {
    path: remotePath,
  });

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw await createYandexApiError(response);
  }

  const data = await response.json();
  if (!data || typeof data.href !== 'string' || !isHttpsUrl(data.href)) {
    throw new Error('Яндекс.Диск не вернул прямую ссылку на файл.');
  }

  return data.href;
}

function uploadFileWithProgress(uploadUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.timeout = 30 * 60 * 1000;

    // Для загрузки на предподписанный URL не нужен Authorization.
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(event.loaded / event.total, 1));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        const error = new Error(
          `Не удалось загрузить файл на Яндекс.Диск (статус ${xhr.status}).`,
        );
        error.status = xhr.status;
        error.code = 'YANDEX_UPLOAD_HTTP';
        reject(error);
      }
    };

    xhr.onerror = () => {
      const error = new Error(
        'Сетевая ошибка при загрузке файла на Яндекс.Диск. Проверьте подключение к интернету.',
      );
      error.code = 'NETWORK_ERROR';
      reject(error);
    };

    xhr.ontimeout = () => {
      const error = new Error(
        'Истекло время загрузки файла на Яндекс.Диск. Попробуйте снова.',
      );
      error.code = 'UPLOAD_TIMEOUT';
      reject(error);
    };

    xhr.onabort = () => {
      reject(new Error('Загрузка файла на Яндекс.Диск была отменена.'));
    };

    xhr.send(file);
  });
}

async function fetchYandexPublicUrl(token, remotePath) {
  const url = buildYandexApiUrl('/resources', {
    path: remotePath,
    fields: 'public_url',
  });

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw await createYandexApiError(response);
    }
    return '';
  }

  const data = await response.json();
  return typeof data.public_url === 'string' ? data.public_url : '';
}

async function publishYandexFile(token, remotePath) {
  const url = buildYandexApiUrl('/resources/publish', {
    path: remotePath,
  });

  const response = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: {
      Authorization: `OAuth ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (response.status === 500) {
    console.error(
      `publishYandexFile: 500 Internal Server Error. URL: ${url}`,
    );
  }

  if (!response.ok) {
    throw await createYandexApiError(response);
  }

  let publicUrl = '';

  try {
    const data = await response.json();
    if (typeof data.public_url === 'string') {
      publicUrl = data.public_url;
    }
  } catch (error) {
    // Публикация могла вернуть пустой ответ — проверим метаданные ниже.
  }

  if (publicUrl) return publicUrl;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    publicUrl = await fetchYandexPublicUrl(token, remotePath);
    if (publicUrl) return publicUrl;

    if (attempt < 4) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  }

  throw new Error(
    'Файл загружен, но Яндекс.Диск не вернул публичную ссылку.',
  );
}

async function publishYandexFileWithRetry(token, remotePath, attempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await publishYandexFile(token, remotePath);
    } catch (error) {
      lastError = error;

      if (error.status !== 500) {
        throw error;
      }

      if (attempt === attempts) break;

      console.warn(
        `publishYandexFile: попытка ${attempt} из ${attempts} завершилась 500. Повтор через 1 секунду.`,
      );
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  }

  console.error(
    `publishYandexFile: не удалось опубликовать файл после ${attempts} попыток. Яндекс.Диск возвращал 500. Попробуйте позже.`,
  );

  const finalError = new Error(
    'Яндекс.Диск временно вернул 500 при публикации файла. Попробуйте позже.',
  );
  finalError.status = 500;
  finalError.code = 'YANDEX_PUBLISH_500';
  finalError.cause = lastError;
  throw finalError;
}

/* ---------- Отображение вложений ---------- */

function isImageAttachment(record) {
  const type = String(record.type || '').toLowerCase();
  return (
    ATTACHMENT_IMAGE_TYPES.has(type) ||
    /\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i.test(record.name || '')
  );
}

function getAttachmentExtension(name) {
  const match = String(name || '').match(/\.([a-z0-9]{1,8})$/i);
  return match ? match[1].toUpperCase() : '';
}

function getAttachmentTypeLabel(record) {
  const extension = getAttachmentExtension(record.name);

  if (extension) return extension;

  const type = String(record.type || '').toLowerCase();
  if (type === 'application/pdf') return 'PDF';
  if (type.startsWith('image/')) return 'IMG';
  return 'ФАЙЛ';
}

function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '0 Б';

  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const unitIndex = Math.min(
    Math.floor(Math.log(size) / Math.log(1024)),
    units.length - 1,
  );
  const value = size / (1024 ** unitIndex);
  const formatted =
    unitIndex === 0
      ? String(Math.round(value))
      : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);

  return `${formatted} ${units[unitIndex]}`;
}

function createAttachmentExtLabel(label) {
  const extension = document.createElement('span');
  extension.className = 'attachment-card__ext';
  extension.textContent = label;
  return extension;
}

function createAttachmentCard(record) {
  const name = record.name || 'Файл';
  const typeLabel = getAttachmentTypeLabel(record);
  const image = isImageAttachment(record);
  const publicUrl = record.public_url;
  const imageUrl = record.direct_url || publicUrl;

  const card = document.createElement('div');
  card.className = 'attachment-card';
  card.dataset.attachmentType = typeLabel;
  card.dataset.attachmentId = record.id;

  let preview;

  if (image) {
    preview = document.createElement('a');
    preview.href = publicUrl;
    preview.target = '_blank';
    preview.rel = 'noopener noreferrer';
    preview.title = `Открыть «${name}»`;

    const imageElement = document.createElement('img');
    imageElement.src = imageUrl;
    imageElement.alt = name;
    imageElement.loading = 'lazy';
    imageElement.decoding = 'async';
    preview.append(imageElement);
  } else {
    preview = document.createElement('span');
    preview.append(createAttachmentExtLabel(typeLabel));
  }

  preview.classList.add('attachment-card__preview');

  const info = document.createElement('div');
  info.className = 'attachment-card__info';

  const nameElement = document.createElement('p');
  nameElement.className = 'attachment-card__name';
  nameElement.textContent = name;
  nameElement.title = name;

  const meta = document.createElement('p');
  meta.className = 'attachment-card__meta';
  meta.textContent = `${typeLabel} · ${formatFileSize(record.size)}`;
  info.append(nameElement, meta);

  const actions = document.createElement('div');
  actions.className = 'attachment-card__actions';

  const download = document.createElement('a');
  download.className = 'attachment-download';
  download.href = publicUrl;
  download.target = '_blank';
  download.rel = 'noopener noreferrer';
  download.download = name;
  download.title = `Скачать «${name}»`;
  download.innerHTML = downloadIcon;

  const downloadLabel = document.createElement('span');
  downloadLabel.textContent = 'Скачать';
  download.append(downloadLabel);
  actions.append(download);

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'attachment-remove';
  removeButton.dataset.action = 'delete-attachment';
  removeButton.dataset.attachmentId = record.id;
  removeButton.title = 'Удалить вложение из заметки';
  removeButton.setAttribute('aria-label', `Удалить вложение «${name}»`);
  removeButton.innerHTML = trashIcon;
  actions.append(removeButton);

  card.append(preview, info, actions);
  return card;
}

function replaceAttachmentPreviewWithFallback(image) {
  const preview = image.closest('.attachment-card__preview');
  const card = image.closest('.attachment-card');

  if (!preview || !card) return;

  preview.replaceChildren(
    createAttachmentExtLabel(card.dataset.attachmentType || 'ФАЙЛ'),
  );
}

async function refreshAttachmentImage(attachmentId, image, card) {
  const noteId = selectedNoteId;

  if (!noteId || !yandexToken) {
    replaceAttachmentPreviewWithFallback(image);
    return;
  }

  const note = getNoteById(noteId);
  const attachment = note?.attachments?.find(
    (item) => item.id === attachmentId,
  );

  if (!attachment || !attachment.remote_path) {
    replaceAttachmentPreviewWithFallback(image);
    return;
  }

  try {
    const directUrl = await getYandexDirectUrl(
      yandexToken,
      attachment.remote_path,
    );

    const latestNote = getNoteById(noteId);
    const latestAttachment = latestNote?.attachments?.find(
      (item) => item.id === attachmentId,
    );

    if (!latestNote || !latestAttachment) {
      throw new Error('Вложение больше не существует.');
    }

    const nextNotes = notes.map((item) =>
      item.id === noteId
        ? {
            ...item,
            attachments: item.attachments.map((current) =>
              current.id === attachmentId
                ? { ...current, direct_url: directUrl }
                : current,
            ),
          }
        : item,
    );

    if (!persistNotes(nextNotes)) {
      console.error(
        'Не удалось сохранить direct_url вложения в localStorage.',
        directUrl,
      );
    }

    if (card.isConnected && image.isConnected) {
      image.src = directUrl;
    }
  } catch (error) {
    console.error(
      'Не удалось обновить прямую ссылку изображения вложения.',
      error,
    );
    replaceAttachmentPreviewWithFallback(image);
  }
}

function handleAttachmentImageError(event) {
  const image = event.target;

  if (!(image instanceof window.HTMLImageElement)) return;

  const preview = image.closest('.attachment-card__preview');
  const card = image.closest('.attachment-card');

  if (!preview || !card || !card.isConnected) return;

  const failedUrl = image.currentSrc || image.src || '';
  console.error(
    `Не удалось загрузить изображение «${image.alt || 'без названия'}». URL: ${failedUrl}`,
  );

  const attachmentId = card.dataset.attachmentId;

  if (
    !attachmentId ||
    !yandexToken ||
    image.dataset.directRetry === '1'
  ) {
    replaceAttachmentPreviewWithFallback(image);
    return;
  }

  image.dataset.directRetry = '1';
  void refreshAttachmentImage(attachmentId, image, card);
}

function renderAttachmentsForNote(note) {
  const records = Array.isArray(note?.attachments) ? [...note.attachments] : [];

  records.sort((first, second) => {
    const firstTime = Date.parse(first.uploadedAt) || 0;
    const secondTime = Date.parse(second.uploadedAt) || 0;
    return firstTime - secondTime;
  });

  attachmentsList.replaceChildren();
  attachmentsEmpty.hidden = records.length > 0;

  if (records.length === 0) {
    attachmentsEmpty.textContent = yandexToken
      ? 'Пока нет вложений.'
      : 'Добавьте OAuth-токен в настройках, чтобы прикреплять файлы.';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const record of records) {
    fragment.append(createAttachmentCard(record));
  }
  attachmentsList.append(fragment);
}

function clearAttachmentsView(message = 'Пока нет вложений.') {
  attachmentsList.replaceChildren();
  attachmentsEmpty.hidden = false;
  attachmentsEmpty.textContent = message;
}

function resetAttachmentsForNewNote() {
  clearAttachmentsView('Вложения станут доступны после сохранения заметки.');
  updateAttachmentControls();
}

function updateAttachmentControls() {
  const hasSavedNote = Boolean(selectedNoteId) && !isCreating;
  const isUploadingCurrentNote =
    attachmentUploading && uploadingNoteId === selectedNoteId;

  attachSpinner.hidden = !attachmentUploading;

  if (attachmentUploading) {
    attachButton.classList.add('is-uploading');
    attachButton.style.setProperty('--upload-progress', `${uploadProgress}%`);
    attachButton.disabled = true;
    attachButton.setAttribute('aria-busy', 'true');
    attachFileLabel.textContent = isUploadingCurrentNote
      ? `Загрузка ${uploadProgress}%`
      : 'Загрузка…';
  } else {
    attachButton.classList.remove('is-uploading');
    attachButton.style.removeProperty('--upload-progress');
    attachButton.disabled = !hasSavedNote;
    attachButton.removeAttribute('aria-busy');
    attachFileLabel.textContent = 'Прикрепить файл';
  }

  if (!hasSavedNote) {
    attachmentsHint.textContent =
      'Сначала сохраните заметку, чтобы прикреплять файлы.';
    return;
  }

  if (attachmentUploading) {
    attachmentsHint.textContent = isUploadingCurrentNote
      ? `Загрузка на Яндекс.Диск: ${uploadProgress}%`
      : 'Дождитесь завершения загрузки файлов.';
    return;
  }

  if (!yandexToken) {
    attachmentsHint.textContent =
      'Добавьте OAuth-токен в настройках, чтобы прикреплять файлы.';
    return;
  }

  attachmentsHint.textContent = 'Файлы загружаются на Яндекс.Диск, до 1 ГБ.';
}

function setUploadProgress(percent) {
  const nextProgress = Math.max(0, Math.min(100, Math.round(percent)));
  if (nextProgress === uploadProgress) return;

  uploadProgress = nextProgress;

  if (attachmentUploading) {
    updateAttachmentControls();
  }
}

function isNetworkFailure(error) {
  if (!error) return false;
  if (error instanceof TypeError) return true;
  if (error.code === 'NETWORK_ERROR' || error.name === 'NetworkError') return true;

  return /failed to fetch|networkerror|load failed|network request failed|сетев/i.test(
    String(error.message || ''),
  );
}

function getUploadErrorMessage(error) {
  if (isNetworkFailure(error)) {
    return 'Не удалось связаться с Яндекс.Диском. Проверьте подключение к интернету и повторите попытку.';
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Не удалось загрузить файл на Яндекс.Диск.';
}

function getOversizedFiles(files) {
  return files.filter((file) => Number(file.size) > MAX_ATTACHMENT_SIZE);
}

function showOversizedFilesError(files) {
  const names = files
    .map((file) => `«${file.name || 'Файл'}»`)
    .join(', ');

  const message =
    files.length === 1
      ? `Файл ${names} больше 1 ГБ. На бесплатном тарифе Яндекс.Диска такие файлы загрузить нельзя.`
      : `Файлы ${names} больше 1 ГБ. На бесплатном тарифе Яндекс.Диска такие файлы загрузить нельзя.`;

  showToast(message, {
    type: 'error',
    duration: 8000,
  });
}

function addAttachmentToNote(noteId, attachment) {
  const note = getNoteById(noteId);
  if (!note) return null;

  const updatedNote = {
    ...note,
    attachments: [...(note.attachments || []), attachment],
  };

  const nextNotes = notes.map((item) =>
    item.id === noteId ? updatedNote : item,
  );

  if (!persistNotes(nextNotes)) return null;

  return getNoteById(noteId);
}

async function uploadFiles(files) {
  if (isCreating || !selectedNoteId) {
    showToast('Сначала сохраните заметку, чтобы прикрепить файлы.', {
      type: 'error',
      duration: 5500,
    });
    return;
  }

  if (!yandexToken) {
    openSettings('Сначала добавьте OAuth-токен Яндекс.Диска.');
    return;
  }

  if (attachmentUploading) return;

  if (navigator.onLine === false) {
    showToast(
      'Нет подключения к интернету. Проверьте сеть и повторите загрузку.',
      {
        type: 'error',
        duration: 7000,
      },
    );
    return;
  }

  const oversizedFiles = getOversizedFiles(files);

  if (oversizedFiles.length > 0) {
    showOversizedFilesError(oversizedFiles);
    return;
  }

  const targetNoteId = selectedNoteId;
  const token = yandexToken;
  const totalFiles = files.length;

  attachmentUploading = true;
  uploadingNoteId = targetNoteId;
  uploadProgress = 0;
  updateAttachmentControls();

  try {
    await ensureAppFolder(token);

    for (let index = 0; index < totalFiles; index += 1) {
      const file = files[index];
      const remotePath = createRemotePath(file);
      const uploadUrl = await getYandexUploadUrl(token, remotePath);

      await uploadFileWithProgress(uploadUrl, file, (fileProgress) => {
        setUploadProgress(((index + fileProgress) / totalFiles) * 100);
      });

      const publicUrl = await publishYandexFileWithRetry(
        token,
        remotePath,
      );

      if (!isHttpsUrl(publicUrl)) {
        throw new Error(
          'Яндекс.Диск вернул некорректную публичную ссылку на файл.',
        );
      }

      let directUrl = '';

      try {
        directUrl = await getYandexDirectUrl(token, remotePath);
      } catch (error) {
        console.error(
          'Не удалось получить прямую ссылку на файл для предпросмотра.',
          error,
        );
      }

      if (!getNoteById(targetNoteId)) {
        throw new Error(
          'Заметка была удалена во время загрузки. Файл остался на Яндекс.Диске.',
        );
      }

      const attachment = {
        id: createId(),
        name: file.name || 'Файл',
        type: file.type || '',
        size: Number(file.size) || 0,
        public_url: publicUrl,
        direct_url: directUrl,
        remote_path: remotePath,
        uploadedAt: new Date().toISOString(),
      };

      const updatedNote = addAttachmentToNote(targetNoteId, attachment);

      if (!updatedNote) {
        throw new Error(
          'Файл загружен, но не удалось сохранить вложение в заметке.',
        );
      }

      if (selectedNoteId === targetNoteId) {
        renderAttachmentsForNote(updatedNote);
      }

      setUploadProgress(((index + 1) / totalFiles) * 100);
    }

    showToast(
      totalFiles === 1
        ? 'Файл загружен на Яндекс.Диск и опубликован.'
        : `Файлы загружены на Яндекс.Диск: ${totalFiles}.`,
    );
  } catch (error) {
    console.error('Не удалось загрузить файл на Яндекс.Диск.', error);

    if (error && error.code === 'YANDEX_UNAUTHORIZED') {
      openSettings(
        'OAuth-токен недействителен или истёк. Вставьте новый токен и сохраните настройки.',
      );
    } else {
      showToast(getUploadErrorMessage(error), {
        type: 'error',
        duration: 8000,
      });
    }
  } finally {
    attachmentUploading = false;
    uploadingNoteId = null;
    uploadProgress = 0;
    updateAttachmentControls();
  }
}

function handleAttachmentSelection(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';

  if (files.length > 0) {
    void uploadFiles(files);
  }
}

function removeAttachment(attachmentId, trigger) {
  const note = getNoteById(selectedNoteId);

  if (!note) return;

  const currentAttachments = Array.isArray(note.attachments)
    ? note.attachments
    : [];
  const nextAttachments = currentAttachments.filter(
    (attachment) => attachment.id !== attachmentId,
  );

  if (nextAttachments.length === currentAttachments.length) return;

  if (trigger) trigger.disabled = true;

  const nextNotes = notes.map((item) =>
    item.id === note.id ? { ...item, attachments: nextAttachments } : item,
  );

  if (!persistNotes(nextNotes)) {
    if (trigger) trigger.disabled = false;
    showToast('Не удалось удалить вложение из заметки.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  renderAttachmentsForNote(getNoteById(note.id));
  updateAttachmentControls();
  showToast('Вложение удалено из заметки.');
}

function handleAttachmentListClick(event) {
  const removeButton = event.target.closest('[data-action="delete-attachment"]');
  if (!removeButton) return;

  event.preventDefault();
  void removeAttachment(removeButton.dataset.attachmentId, removeButton);
}

/* =========================================================
   Резервная копия
   ========================================================= */

function createBackupPayload() {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    // Файлы хранятся на Яндекс.Диске; в JSON попадают публичные ссылки на них.
    notes: notes.map(({ id, title, content, parent_id, updatedAt, attachments }) => ({
      id,
      title,
      content,
      parent_id,
      updatedAt,
      attachments,
    })),
  };
}

function createBackupFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}-${pad(date.getMinutes())}`;

  return `База ${datePart} ${timePart}.json`;
}

function downloadBackup() {
  try {
    const fileName = createBackupFileName();
    const json = `${JSON.stringify(createBackupPayload(), null, 2)}\n`;
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = objectUrl;
    link.download = fileName;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    showToast(`Файл «${fileName}» скачан.`);
  } catch (error) {
    console.error('Не удалось создать резервную копию.', error);
    showToast('Не удалось подготовить файл для скачивания.', {
      type: 'error',
      duration: 6000,
    });
  }
}

function extractNotesFromBackup(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.notes)) return data.notes;
  return null;
}

function prepareImportedNotes(rawNotes) {
  const existingIds = new Set(notes.map((note) => note.id));
  const importedIds = new Set();
  const preparedNotes = [];
  let duplicateCount = 0;
  let invalidCount = 0;

  rawNotes.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalidCount += 1;
      return;
    }

    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';

    if (!title && !content) {
      invalidCount += 1;
      return;
    }

    const requestedId = typeof entry.id === 'string' ? entry.id.trim() : '';

    if (requestedId && (existingIds.has(requestedId) || importedIds.has(requestedId))) {
      duplicateCount += 1;
      return;
    }

    let id = requestedId;
    while (!id || existingIds.has(id) || importedIds.has(id)) {
      id = createId();
    }

    const parentId =
      typeof entry.parent_id === 'string' && entry.parent_id.trim()
        ? entry.parent_id.trim()
        : null;

    preparedNotes.push({
      id,
      title: title || 'Без названия',
      content,
      parent_id: parentId,
      updatedAt: normalizeTimestamp(entry.updatedAt),
      attachments: normalizeAttachments(entry.attachments),
    });
    importedIds.add(id);
  });

  return { notes: preparedNotes, duplicateCount, invalidCount };
}

async function importNotesFromFile(file) {
  if (file.size > MAX_IMPORT_FILE_SIZE) {
    showToast('Файл слишком большой. Максимальный размер — 10 МБ.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  let text;
  try {
    text = await file.text();
  } catch (error) {
    console.error('Не удалось прочитать выбранный файл.', error);
    showToast('Не удалось прочитать выбранный файл.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    console.warn('Выбранный файл не является корректным JSON.', error);
    showToast('Не удалось прочитать JSON. Проверьте, что выбран файл notes.json.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  const rawNotes = extractNotesFromBackup(data);
  if (!rawNotes) {
    showToast('В файле нет списка заметок. Выберите файл notes.json, созданный этим приложением.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  if (rawNotes.length === 0) {
    showToast('В выбранном файле нет заметок.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  const { notes: preparedNotes, duplicateCount, invalidCount } =
    prepareImportedNotes(rawNotes);

  if (preparedNotes.length === 0) {
    if (duplicateCount > 0) {
      showToast('Все заметки из этого файла уже есть в базе.');
    } else {
      showToast('В файле не нашлось заметок в поддерживаемом формате.', {
        type: 'error',
        duration: 6000,
      });
    }
    return;
  }

  const mergedNotes = sanitizeNotes([...notes, ...preparedNotes]);

  if (!persistNotes(mergedNotes)) {
    showToast('Не удалось загрузить заметки. Возможно, хранилище браузера заполнено.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  const currentParent = parentSelect.value;
  populateParentSelect(
    isCreating ? null : selectedNoteId,
    currentParent,
  );
  renderTree();
  renderHomeStats();
  renderBreadcrumbs();

  const addedCount = preparedNotes.length;
  const isSingular = addedCount % 10 === 1 && addedCount % 100 !== 11;
  let message = isSingular
    ? `Добавлена ${addedCount} заметка.`
    : `Добавлено ${addedCount} ${getNoteWord(addedCount)}.`;

  if (duplicateCount > 0) {
    message += ' Дубликаты пропущены.';
  } else if (invalidCount > 0) {
    message += ` Пропущено записей: ${invalidCount}.`;
  }

  showToast(message, { duration: 5500 });
}

async function handleImportChange(event) {
  const file = event.target.files?.[0];
  event.target.value = '';

  if (!file) return;

  importButton.disabled = true;

  try {
    await importNotesFromFile(file);
  } catch (error) {
    console.error('Не удалось импортировать заметки.', error);
    showToast('Не удалось загрузить базу. Попробуйте ещё раз.', {
      type: 'error',
      duration: 6000,
    });
  } finally {
    importButton.disabled = false;
  }
}

/* =========================================================
   Мобильная боковая панель
   ========================================================= */

function openMobileSidebar() {
  if (window.innerWidth > 900) return;

  isMobileSidebarOpen = true;
  sidebar.classList.add('is-open');
  sidebarScrim.classList.add('is-visible');
  sidebarToggle.setAttribute('aria-expanded', 'true');
  document.body.classList.add('sidebar-open');
  sidebarClose.focus();
}

function closeMobileSidebar({ restoreFocus = false } = {}) {
  if (!isMobileSidebarOpen) return;

  isMobileSidebarOpen = false;
  sidebar.classList.remove('is-open');
  sidebarScrim.classList.remove('is-visible');
  sidebarToggle.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sidebar-open');

  if (restoreFocus) sidebarToggle.focus();
}

function scrollToTop() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}

/* =========================================================
   Уведомления
   ========================================================= */

function showToast(message, { type = 'success', actionLabel = '', onAction = null, duration = 4500 } = {}) {
  window.clearTimeout(toastTimerId);

  toastMessage.textContent = message;
  toast.classList.toggle('toast--error', type === 'error');

  if (actionLabel && typeof onAction === 'function') {
    toastAction.textContent = actionLabel;
    toastAction.hidden = false;
    toastActionHandler = onAction;
  } else {
    toastAction.hidden = true;
    toastAction.textContent = '';
    toastActionHandler = null;
  }

  toast.classList.add('is-visible');
  toastTimerId = window.setTimeout(hideToast, duration);
}

function hideToast() {
  window.clearTimeout(toastTimerId);
  toastTimerId = null;
  toast.classList.remove('is-visible');
  toastAction.hidden = true;
  toastActionHandler = null;
}

/* =========================================================
   События
   ========================================================= */

brandHome.addEventListener('click', showHome);
homeNewNote.addEventListener('click', () => startCreatingNote(null));

newNoteButton.addEventListener('click', () => {
  const parentId = isCreating ? draftParentId : selectedNoteId;
  startCreatingNote(parentId);
});

sortToggle.addEventListener('click', () => {
  sortByUpdated = !sortByUpdated;
  updateSortToggle();
  persistSortPreference();
  renderTree();
});

form.addEventListener('submit', handleSubmit);

form.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    form.requestSubmit();
  }
});

titleInput.addEventListener('input', () => clearFieldError(titleInput, titleError));

contentInput.addEventListener('input', () => {
  debouncedContentCount();
  clearFieldError(contentInput, contentError);
});

parentSelect.addEventListener('change', () => {
  if (!isCreating) return;

  draftParentId = parentSelect.value || null;
  renderBreadcrumbs();
});

deleteButton.addEventListener('click', deleteCurrentNote);

attachButton.addEventListener('click', () => {
  if (attachButton.disabled) return;

  if (!selectedNoteId || isCreating) {
    showToast('Сначала сохраните заметку, чтобы прикрепить файлы.', {
      type: 'error',
      duration: 5500,
    });
    return;
  }

  if (!yandexToken) {
    openSettings('Сначала добавьте OAuth-токен Яндекс.Диска.');
    return;
  }

  attachmentInput.click();
});
attachmentInput.addEventListener('change', handleAttachmentSelection);
attachmentsList.addEventListener('click', handleAttachmentListClick);
attachmentsList.addEventListener('error', handleAttachmentImageError, true);

settingsOpenButton.addEventListener('click', () => openSettings());
settingsCloseButton.addEventListener('click', () => closeSettings());
settingsForm.addEventListener('submit', handleSettingsSubmit);
settingsClearButton.addEventListener('click', handleClearYandexToken);
yandexTokenInput.addEventListener('input', () => setSettingsError(''));
settingsDialog.addEventListener('click', (event) => {
  if (event.target === settingsDialog) {
    closeSettings();
  }
});
settingsDialog.addEventListener('close', () => {
  document.body.classList.remove('settings-open');
  setSettingsError('');
});

tree.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-action="toggle-branch"]');

  if (toggle) {
    toggleBranch(toggle.dataset.noteId, toggle);
    return;
  }

  const link = event.target.closest('[data-action="open-note"]');
  if (link) openNote(link.dataset.noteId);
});

breadcrumbs.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  if (target.dataset.action === 'go-home') {
    showHome();
  } else if (target.dataset.action === 'open-note') {
    openNote(target.dataset.noteId);
  }
});

exportButton.addEventListener('click', downloadBackup);
importButton.addEventListener('click', () => importFileInput.click());
importFileInput.addEventListener('change', handleImportChange);

sidebarToggle.addEventListener('click', openMobileSidebar);
sidebarClose.addEventListener('click', () => closeMobileSidebar({ restoreFocus: true }));
sidebarScrim.addEventListener('click', () => closeMobileSidebar({ restoreFocus: true }));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isMobileSidebarOpen) {
    closeMobileSidebar({ restoreFocus: true });
  }
});

const handleWindowResize = debounce(() => {
  if (window.innerWidth > 900) {
    closeMobileSidebar();
  }
}, 150);

window.addEventListener('resize', handleWindowResize);

toastAction.addEventListener('click', () => {
  const handler = toastActionHandler;
  hideToast();
  if (handler) handler();
});

/* =========================================================
   Запуск
   ========================================================= */

notes = readNotes();
sortByUpdated = readSortPreference();
yandexToken = readYandexToken();
settingsClearButton.disabled = !yandexToken;
updateSortToggle();
updateContentCount();
showHome();
