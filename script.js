'use strict';

/* =========================================================
   Личная база знаний — иерархия, редактор, резервные копии
   ========================================================= */

const STORAGE_KEY = 'knowledge-base.notes.v1';
const SORT_STORAGE_KEY = 'knowledge-base.sort-by-updated';
const MAX_CONTENT_LENGTH = 20000;
const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024;
const BACKUP_FORMAT = 'personal-knowledge-base';
const BACKUP_VERSION = 3;
const ATTACHMENT_DB_NAME = 'knowledge-base-files';
const ATTACHMENT_DB_VERSION = 1;
const ATTACHMENT_STORE_NAME = 'attachments';
const ATTACHMENT_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
]);
const NOTE_UNDO_DURATION = 7000;
const ATTACHMENT_CLEANUP_DELAY = 9000;

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
const attachmentInput = document.querySelector('#attachment-input');
const attachmentsList = document.querySelector('#attachments-list');
const attachmentsHint = document.querySelector('#attachments-hint');
const attachmentsEmpty = document.querySelector('#attachments-empty');
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

let attachmentDbPromise = null;
let attachmentObjectUrls = [];
let attachmentLoadToken = 0;
let attachmentsAvailable = Boolean(window.indexedDB);
let attachmentLoading = false;
let attachmentUploading = false;
let attachmentStorageErrorShown = false;
let notesStorageReadSucceeded = false;
let deleteLocked = false;
const pendingAttachmentCleanupTimers = new Map();

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

function sanitizeNotes(list) {
  const cleaned = list.map((note) => ({
    ...note,
    parent_id: note.parent_id || null,
    updatedAt: normalizeTimestamp(note.updatedAt),
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
    if (!raw) {
      notesStorageReadSucceeded = true;
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      notesStorageReadSucceeded = false;
      return [];
    }

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

    notesStorageReadSucceeded = true;
    return cleanNotes;
  } catch (error) {
    notesStorageReadSucceeded = false;
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
  invalidateAttachmentsView();
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

function fillEditor(note, { reloadAttachments = true } = {}) {
  titleInput.value = note.title;
  contentInput.value = note.content;
  populateParentSelect(note.id, note.parent_id);
  setEditorMode(false);
  debouncedContentCount.cancel();
  updateContentCount();
  renderUpdatedAt(note.updatedAt);
  clearFieldError(titleInput, titleError);
  clearFieldError(contentInput, contentError);

  if (reloadAttachments) {
    void loadAttachmentsForNote(note.id);
  }
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
  fillEditor(storedNote, { reloadAttachments: creating });

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

  scheduleAttachmentCleanup(removedNote.id);

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
      cancelAttachmentCleanup(removedNote.id);

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
   Вложения (IndexedDB)
   ========================================================= */

function openAttachmentDb() {
  if (!attachmentsAvailable) {
    return Promise.reject(new Error('Хранилище файлов недоступно.'));
  }

  if (attachmentDbPromise) return attachmentDbPromise;

  attachmentDbPromise = new Promise((resolve, reject) => {
    let request;

    try {
      request = window.indexedDB.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
    } catch (error) {
      attachmentsAvailable = false;
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      let store;

      if (!db.objectStoreNames.contains(ATTACHMENT_STORE_NAME)) {
        store = db.createObjectStore(ATTACHMENT_STORE_NAME, { keyPath: 'id' });
      } else {
        store = request.transaction.objectStore(ATTACHMENT_STORE_NAME);
      }

      if (!store.indexNames.contains('noteId')) {
        store.createIndex('noteId', 'noteId', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        attachmentDbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error || new Error('Не удалось открыть хранилище файлов.'));
    };
  }).catch((error) => {
    attachmentDbPromise = null;
    attachmentsAvailable = false;
    throw error;
  });

  return attachmentDbPromise;
}

async function addAttachmentRecords(records) {
  const db = await openAttachmentDb();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(ATTACHMENT_STORE_NAME);

    for (const record of records) {
      store.put(record);
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error('Не удалось сохранить вложения.'));
    transaction.onabort = () =>
      reject(transaction.error || new Error('Не удалось сохранить вложения.'));
  });
}

async function getAttachmentsForNote(noteId) {
  const db = await openAttachmentDb();

  const records = await new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE_NAME, 'readonly');
    const index = transaction.objectStore(ATTACHMENT_STORE_NAME).index('noteId');
    const request = index.getAll(window.IDBKeyRange.only(noteId));

    transaction.onerror = () =>
      reject(transaction.error || new Error('Не удалось прочитать вложения.'));
    transaction.onabort = () =>
      reject(transaction.error || new Error('Не удалось прочитать вложения.'));
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () =>
      reject(request.error || new Error('Не удалось прочитать вложения.'));
  });

  return records.sort((first, second) => {
    const firstTime = Date.parse(first.createdAt) || 0;
    const secondTime = Date.parse(second.createdAt) || 0;
    return firstTime - secondTime;
  });
}

async function deleteAttachmentRecords(attachmentIds) {
  if (attachmentIds.length === 0) return;

  const db = await openAttachmentDb();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(ATTACHMENT_STORE_NAME);

    for (const attachmentId of attachmentIds) {
      store.delete(attachmentId);
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error('Не удалось удалить вложения.'));
    transaction.onabort = () =>
      reject(transaction.error || new Error('Не удалось удалить вложения.'));
  });
}

async function deleteAttachmentRecord(attachmentId) {
  await deleteAttachmentRecords([attachmentId]);
}

async function getAttachmentIdsForNote(noteId) {
  const db = await openAttachmentDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE_NAME, 'readonly');
    const index = transaction.objectStore(ATTACHMENT_STORE_NAME).index('noteId');
    const request = index.getAllKeys(window.IDBKeyRange.only(noteId));

    transaction.onerror = () =>
      reject(transaction.error || new Error('Не удалось прочитать вложения.'));
    transaction.onabort = () =>
      reject(transaction.error || new Error('Не удалось прочитать вложения.'));
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () =>
      reject(request.error || new Error('Не удалось прочитать вложения.'));
  });
}

async function deleteAttachmentsForNote(noteId) {
  const attachmentIds = await getAttachmentIdsForNote(noteId);
  if (attachmentIds.length === 0) return 0;

  await deleteAttachmentRecords(attachmentIds);
  return attachmentIds.length;
}

async function getAttachmentNoteIds() {
  const db = await openAttachmentDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE_NAME, 'readonly');
    const index = transaction.objectStore(ATTACHMENT_STORE_NAME).index('noteId');
    const noteIds = new Set();
    const request = index.openKeyCursor();

    transaction.onerror = () =>
      reject(transaction.error || new Error('Не удалось прочитать вложения.'));
    transaction.onabort = () =>
      reject(transaction.error || new Error('Не удалось прочитать вложения.'));
    request.onerror = () =>
      reject(request.error || new Error('Не удалось прочитать вложения.'));
    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) {
        resolve([...noteIds]);
        return;
      }

      noteIds.add(cursor.key);
      cursor.continue();
    };
  });
}

async function cleanupOrphanedAttachments(validNoteIds) {
  if (!attachmentsAvailable) return;

  try {
    const attachmentNoteIds = await getAttachmentNoteIds();
    const orphanNoteIds = attachmentNoteIds.filter(
      (noteId) => !validNoteIds.has(noteId),
    );

    for (const noteId of orphanNoteIds) {
      if (getNoteById(noteId)) continue;
      await deleteAttachmentsForNote(noteId);
    }

    if (orphanNoteIds.length > 0) {
      console.info(`Очищены вложения для удалённых заметок: ${orphanNoteIds.length}.`);
    }
  } catch (error) {
    console.warn('Не удалось очистить вложения удалённых заметок.', error);
  }
}

function scheduleAttachmentCleanup(noteId) {
  if (!attachmentsAvailable) return;

  const existingTimer = pendingAttachmentCleanupTimers.get(noteId);
  if (existingTimer) window.clearTimeout(existingTimer);

  const timerId = window.setTimeout(() => {
    pendingAttachmentCleanupTimers.delete(noteId);

    if (getNoteById(noteId)) return;

    deleteAttachmentsForNote(noteId).catch((error) => {
      console.warn('Не удалось удалить вложения удалённой заметки.', error);
    });
  }, ATTACHMENT_CLEANUP_DELAY);

  pendingAttachmentCleanupTimers.set(noteId, timerId);
}

function cancelAttachmentCleanup(noteId) {
  const timerId = pendingAttachmentCleanupTimers.get(noteId);
  if (!timerId) return;

  window.clearTimeout(timerId);
  pendingAttachmentCleanupTimers.delete(noteId);
}

function releaseAttachmentObjectUrls() {
  for (const objectUrl of attachmentObjectUrls) {
    URL.revokeObjectURL(objectUrl);
  }

  attachmentObjectUrls = [];
}

function isImageAttachment(record) {
  const type = String(record.type || record.blob?.type || '').toLowerCase();
  return ATTACHMENT_IMAGE_TYPES.has(type) || /\.(jpe?g|png|gif)$/i.test(record.name || '');
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

function createAttachmentCard(record) {
  const name = record.name || 'Файл';
  const typeLabel = getAttachmentTypeLabel(record);
  const image = isImageAttachment(record);
  let objectUrl = '';

  if (record.blob) {
    try {
      objectUrl = URL.createObjectURL(record.blob);
      attachmentObjectUrls.push(objectUrl);
    } catch (error) {
      console.warn('Не удалось создать ссылку на вложение.', error);
    }
  }

  const card = document.createElement('div');
  card.className = `attachment-card${image && objectUrl ? ' attachment-card--image' : ' attachment-card--file'}`;

  let preview;
  if (image && objectUrl) {
    preview = document.createElement('a');
    preview.href = objectUrl;
    preview.target = '_blank';
    preview.rel = 'noopener';
    preview.title = `Открыть «${name}»`;

    const imageElement = document.createElement('img');
    imageElement.src = objectUrl;
    imageElement.alt = name;
    imageElement.loading = 'lazy';
    imageElement.decoding = 'async';
    preview.append(imageElement);
  } else {
    preview = document.createElement('span');
    const extension = document.createElement('span');
    extension.className = 'attachment-card__ext';
    extension.textContent = typeLabel;
    preview.append(extension);
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

  if (objectUrl) {
    const download = document.createElement('a');
    download.className = 'attachment-download';
    download.href = objectUrl;
    download.download = name;
    download.title = `Скачать «${name}»`;
    download.innerHTML = downloadIcon;

    const downloadLabel = document.createElement('span');
    downloadLabel.textContent = 'Скачать';
    download.append(downloadLabel);
    actions.append(download);
  }

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'attachment-remove';
  removeButton.dataset.action = 'delete-attachment';
  removeButton.dataset.attachmentId = record.id;
  removeButton.title = 'Удалить вложение';
  removeButton.setAttribute('aria-label', `Удалить вложение «${name}»`);
  removeButton.innerHTML = trashIcon;
  actions.append(removeButton);

  card.append(preview, info, actions);
  return card;
}

function renderAttachments(records) {
  releaseAttachmentObjectUrls();
  attachmentsList.replaceChildren();

  const validRecords = records
    .filter((record) => record && record.id)
    .sort((first, second) => {
      const firstTime = Date.parse(first.createdAt) || 0;
      const secondTime = Date.parse(second.createdAt) || 0;
      return firstTime - secondTime;
    });

  attachmentsEmpty.hidden = validRecords.length > 0;
  attachmentsEmpty.textContent = 'Пока нет вложений.';

  if (validRecords.length === 0) return;

  const fragment = document.createDocumentFragment();
  for (const record of validRecords) {
    fragment.append(createAttachmentCard(record));
  }
  attachmentsList.append(fragment);
}

function updateAttachmentControls() {
  if (!attachmentsAvailable) {
    attachButton.disabled = true;
    attachmentsHint.textContent = 'Хранение файлов недоступно в этом браузере.';
    return;
  }

  const hasSavedNote = Boolean(selectedNoteId) && !isCreating;
  attachButton.disabled =
    !hasSavedNote || attachmentLoading || attachmentUploading;

  if (!hasSavedNote) {
    attachmentsHint.textContent = 'Сначала сохраните заметку, чтобы прикрепить файлы.';
    return;
  }

  if (attachmentUploading) {
    attachmentsHint.textContent = 'Добавляем файлы…';
  } else if (attachmentLoading) {
    attachmentsHint.textContent = 'Загрузка вложений…';
  } else {
    attachmentsHint.textContent = 'Изображения и документы, привязанные к этой заметке.';
  }
}

function invalidateAttachmentsView(message = 'Пока нет вложений.') {
  attachmentLoadToken += 1;
  attachmentLoading = false;
  releaseAttachmentObjectUrls();
  attachmentsList.replaceChildren();
  attachmentsEmpty.hidden = false;
  attachmentsEmpty.textContent = message;
}

function resetAttachmentsForNewNote() {
  invalidateAttachmentsView('Вложения станут доступны после сохранения заметки.');
  updateAttachmentControls();
}

async function loadAttachmentsForNote(noteId) {
  const token = ++attachmentLoadToken;

  releaseAttachmentObjectUrls();
  attachmentsList.replaceChildren();
  attachmentsEmpty.hidden = false;
  attachmentsEmpty.textContent = 'Загрузка вложений…';
  attachmentLoading = true;
  updateAttachmentControls();

  if (!attachmentsAvailable) {
    attachmentLoading = false;
    attachmentsEmpty.textContent = 'Хранение файлов недоступно в этом браузере.';
    updateAttachmentControls();
    return false;
  }

  try {
    const records = await getAttachmentsForNote(noteId);

    if (token !== attachmentLoadToken || selectedNoteId !== noteId || isCreating) {
      return false;
    }

    renderAttachments(records);
    return true;
  } catch (error) {
    if (token !== attachmentLoadToken) return false;

    console.error('Не удалось загрузить вложения.', error);
    attachmentsAvailable = false;
    releaseAttachmentObjectUrls();
    attachmentsList.replaceChildren();
    attachmentsEmpty.hidden = false;
    attachmentsEmpty.textContent = 'Не удалось загрузить вложения.';

    if (!attachmentStorageErrorShown) {
      showToast('Не удалось открыть хранилище файлов.', {
        type: 'error',
        duration: 6000,
      });
      attachmentStorageErrorShown = true;
    }

    return false;
  } finally {
    if (token === attachmentLoadToken) {
      attachmentLoading = false;
      updateAttachmentControls();
    }
  }
}

async function hasAttachmentCapacity(bytes) {
  if (!bytes || !navigator.storage || typeof navigator.storage.estimate !== 'function') {
    return true;
  }

  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (!quota) return true;
    return usage + bytes <= quota * 0.95;
  } catch (error) {
    return true;
  }
}

async function attachFiles(files) {
  if (isCreating || !selectedNoteId) {
    showToast('Сначала сохраните заметку, чтобы прикрепить файлы.', {
      type: 'error',
      duration: 5500,
    });
    return;
  }

  if (!attachmentsAvailable) {
    showToast('Хранение файлов недоступно в этом браузере.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  const targetNoteId = selectedNoteId;
  const records = files.map((file) => ({
    id: createId(),
    noteId: targetNoteId,
    name: file.name || 'Файл',
    type: file.type || '',
    size: Number(file.size) || 0,
    lastModified: Number(file.lastModified) || Date.now(),
    createdAt: new Date().toISOString(),
    blob: file,
  }));
  const totalSize = records.reduce((sum, record) => sum + record.size, 0);

  attachmentUploading = true;
  updateAttachmentControls();

  try {
    if (!(await hasAttachmentCapacity(totalSize))) {
      showToast('Недостаточно места в хранилище браузера для выбранных файлов.', {
        type: 'error',
        duration: 6000,
      });
      return;
    }

    await addAttachmentRecords(records);

    // Заметку могли удалить, пока файл копировался в IndexedDB.
    if (!getNoteById(targetNoteId)) {
      await deleteAttachmentRecords(records.map((record) => record.id));
      return;
    }

    const message =
      records.length === 1
        ? `Файл «${shorten(records[0].name, 36)}» прикреплён.`
        : `Прикреплено файлов: ${records.length}.`;

    if (selectedNoteId === targetNoteId && !isCreating) {
      const loaded = await loadAttachmentsForNote(targetNoteId);
      if (loaded) showToast(message);
    } else {
      showToast(message);
    }
  } catch (error) {
    console.error('Не удалось прикрепить файлы.', error);
    showToast('Не удалось прикрепить файлы. Возможно, в хранилище не хватает места.', {
      type: 'error',
      duration: 6000,
    });
  } finally {
    attachmentUploading = false;
    updateAttachmentControls();
  }
}

function handleAttachmentSelection(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';

  if (files.length > 0) {
    void attachFiles(files);
  }
}

async function removeAttachment(attachmentId, trigger) {
  if (!attachmentId) return;

  const noteId = selectedNoteId;
  if (trigger) trigger.disabled = true;

  try {
    await deleteAttachmentRecord(attachmentId);

    if (selectedNoteId === noteId) {
      const loaded = await loadAttachmentsForNote(noteId);
      if (loaded) showToast('Вложение удалено.');
    } else {
      showToast('Вложение удалено.');
    }
  } catch (error) {
    console.error('Не удалось удалить вложение.', error);
    if (trigger) trigger.disabled = false;
    showToast('Не удалось удалить вложение.', {
      type: 'error',
      duration: 6000,
    });
  }
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
    // Файлы из IndexedDB намеренно не сериализуются в JSON —
    // резервная копия содержит только структуру и текст заметок.
    notes: notes.map(({ id, title, content, parent_id, updatedAt }) => ({
      id,
      title,
      content,
      parent_id,
      updatedAt,
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

attachButton.addEventListener('click', () => attachmentInput.click());
attachmentInput.addEventListener('change', handleAttachmentSelection);
attachmentsList.addEventListener('click', handleAttachmentListClick);
window.addEventListener('pagehide', releaseAttachmentObjectUrls);

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
updateSortToggle();
updateContentCount();
showHome();

if (notesStorageReadSucceeded) {
  void cleanupOrphanedAttachments(new Set(notes.map((note) => note.id)));
}
