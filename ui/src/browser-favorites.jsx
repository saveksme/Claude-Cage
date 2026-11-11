import { InlineSelect } from "./inline-select";
import { shortcut } from "./platform.mjs";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Folder,
  FolderPlus,
  Pencil,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./api";
import { Modal } from "./views";

// The saved page is primary, folder context secondary, management actions quiet.
// Reuse paper/strong/muted/line tokens, 8/12/16px spacing and existing modal forms.
export function BrowserFavorites({ current, ready, onOpen, shortcuts = true, menu = false, returnFocusRef }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState(null);
  const [folder, setFolder] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const search = useRef();
  const toggle = useRef();
  const savingRef = useRef(false);
  const state = useRef();
  const favorite = data?.items.find((item) => item.url === current?.url);
  let canSave = false;
  try {
    const url = new URL(current?.url);
    canSave =
      current?.kind === "web" &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password;
  } catch {
    /* Browser internal pages cannot be bookmarked. */
  }
  const load = async () => {
    try {
      setData(await api("/favorites"));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  };
  const addCurrent = () => {
    if (!canSave || !data) return;
    setError("");
    setEditor({
      kind: "item",
      ...(favorite || {
        title: current.title || current.url,
        url: current.url,
        folder_id: "",
      }),
    });
  };
  const show = () => {
    setOpen(true);
    void load();
  };
  state.current = { open, editor, addCurrent, show, shortcuts };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const add = () => state.current.shortcuts && state.current.addCurrent();
    const show = () => state.current.shortcuts && state.current.show();
    const close = () => {
      if (!state.current.editor && !savingRef.current) setOpen(false);
    };
    document.addEventListener("cage-add-favorite", add);
    document.addEventListener("cage-show-favorites", show);
    document.addEventListener("cage-close-modal", close);
    return () => {
      document.removeEventListener("cage-add-favorite", add);
      document.removeEventListener("cage-show-favorites", show);
      document.removeEventListener("cage-close-modal", close);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const key = (event) => {
      if (
        event.key === "Escape" &&
        !state.current.editor &&
        !savingRef.current
      ) {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      (returnFocusRef?.current || toggle.current)?.focus();
    };
  }, [open, returnFocusRef]);
  const mutation = async (body) => {
    const next = await api("/favorites", body);
    setData(next);
    return next;
  };
  const run = async (operation) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(e.message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const save = (event) => {
    event.preventDefault();
    void run(async () => {
      if (editor.kind === "folder") {
        await mutation({
          action: "save_folder",
          id: editor.id || "",
          title: editor.title,
        });
      } else {
        let folderID = editor.folder_id;
        if (editor.newFolder?.trim()) {
          const next = await mutation({
            action: "save_folder",
            title: editor.newFolder.trim(),
          });
          folderID = next.folders.at(-1).id;
          setEditor((draft) => ({
            ...draft,
            folder_id: folderID,
            newFolder: "",
          }));
        }
        await mutation({
          action: "save",
          id: editor.id || "",
          title: editor.title,
          url: editor.url,
          folder_id: folderID,
        });
      }
      setEditor(null);
    });
  };
  const remove = (id, isFolder = false) =>
    run(async () => {
      await mutation({ action: isFolder ? "delete_folder" : "delete", id });
      if (isFolder) setFolder("");
      else setEditor(null);
    });
  const visible = (data?.items || []).filter(
    (item) =>
      (folder === "all" || item.folder_id === folder) &&
      `${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedFolder = data?.folders.find((item) => item.id === folder);
  return (
    <>
      <div className="favorites-actions">
        <button
          className={`${menu ? "browser-menu-item" : "icon-button"} favorite-star ${favorite ? "saved" : ""}`}
          role={menu ? "menuitem" : undefined}
          aria-label={favorite ? "Изменить закладку этой страницы" : "Добавить страницу в закладки"}
          title={shortcut(favorite ? "Изменить закладку этой страницы ⌘D" : "Добавить страницу в закладки ⌘D")}
          disabled={!canSave || !data}
          onClick={(event) => {
            event.currentTarget.focus();
            addCurrent();
          }}
        >
          <Star size={17} fill={favorite ? "currentColor" : "none"} />
          {menu && <span>{favorite ? "Изменить закладку этой страницы" : "Добавить страницу в закладки"}</span>}
        </button>
        <button
          ref={toggle}
          className={menu ? "browser-menu-item" : "icon-button"}
          role={menu ? "menuitem" : undefined}
          aria-label="Закладки"
          title={shortcut("Закладки ⌘⇧O")}
          aria-expanded={open}
          onClick={() => (open ? setOpen(false) : show())}
        >
          <Folder size={17} />
          {menu && <span>Закладки</span>}
        </button>
      </div>
      {open &&
        createPortal(
          <>
            <div
              className="favorites-dismiss"
              onClick={() => {
                if (!saving) setOpen(false);
              }}
            />
            <section
              className="favorites-panel"
              role="dialog"
              aria-label="Закладки"
              data-browser-dialog
            >
              <header>
                <h2>Закладки</h2>
                <button
                  className="icon-button"
                  aria-label="Новая папка закладок"
                  title="Новая папка закладок"
                  disabled={!data || saving}
                  onClick={() => {
                    setError("");
                    setEditor({ kind: "folder", title: "" });
                  }}
                >
                  <FolderPlus size={17} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Закрыть закладки"
                  onClick={() => setOpen(false)}
                >
                  <X size={17} />
                </button>
              </header>
              <label className="favorites-search">
                <Search size={15} />
                <input
                  ref={search}
                  aria-label="Поиск закладок"
                  placeholder="Поиск закладок"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="favorites-folder-select">
                <InlineSelect
                  aria-label="Фильтр по папкам закладок"
                  value={folder}
                  onValueChange={(next) => setFolder(next)}
                >
                  <option value="all">Все закладки</option>
                  <option value="">Без папки</option>
                  {data?.folders.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </InlineSelect>
                {selectedFolder && (
                  <>
                    <button
                      className="icon-button"
                      aria-label="Переименовать папку закладок"
                      title="Переименовать папку закладок"
                      disabled={saving}
                      onClick={() => {
                        setError("");
                        setEditor({ kind: "folder", ...selectedFolder });
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Удалить папку закладок; закладки перейдут в «Без папки»"
                      title="Удалить папку закладок; закладки перейдут в «Без папки»"
                      disabled={saving}
                      onClick={() => remove(folder, true)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
              {error && !editor && (
                <div className="favorites-error" role="alert">
                  {error}
                  <button onClick={load}>Повторить чтение</button>
                </div>
              )}
              <div className="favorites-list">
                {!data && !error && (
                  <p className="favorites-empty">Чтение закладок…</p>
                )}
                {data && visible.length === 0 && (
                  <div className="favorites-empty">
                    <Star size={24} />
                    <p>{query ? "Закладки не найдены" : "Здесь пока нет закладок"}</p>
                    <span>
                      {query
                        ? "Попробуйте другое название или адрес."
                        : "Нажмите звезду рядом с адресной строкой, чтобы сохранить нужную страницу."}
                    </span>
                  </div>
                )}
                {visible.map((item) => (
                  <div className="favorite-row" key={item.id}>
                    <button
                      className="favorite-link"
                      disabled={!ready || saving}
                      title={item.url}
                      onClick={() =>
                        run(async () => {
                          if (await onOpen(item.url)) setOpen(false);
                        })
                      }
                    >
                      <Star size={15} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.url}</small>
                      </span>
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Изменить закладку ${item.title}`}
                      title="Изменить закладку"
                      disabled={saving}
                      onClick={() => {
                        setError("");
                        setEditor({ kind: "item", ...item });
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                ))}
              </div>
              {data && (
                <footer>
                  Закладок: {visible.length}{" "}<span>хранятся в этой среде Cage</span>
                </footer>
              )}
            </section>
          </>,
          document.body,
        )}
      {editor &&
        createPortal(
          <div className="favorite-editor" data-browser-dialog>
            <Modal
              title={
                editor.kind === "folder"
                  ? editor.id
                    ? "Переименовать папку закладок"
                    : "Новая папка закладок"
                  : editor.id
                    ? "Изменить закладку"
                    : "Добавить закладку"
              }
              onClose={
                saving
                  ? undefined
                  : () => {
                      setEditor(null);
                      setError("");
                    }
              }
              footer={
                <>
                  {editor.kind === "item" && editor.id && (
                    <button
                      className="favorite-remove"
                      disabled={saving}
                      onClick={() => remove(editor.id)}
                    >
                      Удалить закладку
                    </button>
                  )}
                  <button
                    disabled={saving}
                    onClick={() => {
                      setEditor(null);
                      setError("");
                    }}
                  >
                    Отмена
                  </button>
                  <button
                    className="primary"
                    type="submit"
                    form="favorite-form"
                    disabled={saving}
                  >
                    {saving ? "Сохранение…" : "Сохранить"}
                  </button>
                </>
              }
            >
              <form
                id="favorite-form"
                className="favorite-form"
                onSubmit={save}
              >
                <label>
                  Название
                  <input
                    aria-label="Название закладки"
                    required
                    maxLength={250}
                    value={editor.title}
                    onChange={(event) =>
                      setEditor({ ...editor, title: event.target.value })
                    }
                  />
                </label>
                {editor.kind === "item" && (
                  <>
                    <label>
                      Адрес
                      <input
                        aria-label="Адрес закладки"
                        type="url"
                        required
                        value={editor.url}
                        onChange={(event) =>
                          setEditor({ ...editor, url: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Папка закладок
                      <InlineSelect
                        aria-label="Сохранить в папку закладок"
                        value={editor.folder_id}
                        disabled={Boolean(editor.newFolder)}
                        onValueChange={(next) =>
                          setEditor({
                            ...editor,
                            folder_id: next,
                          })
                        }
                      >
                        <option value="">Без папки</option>
                        {data?.folders.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                      </InlineSelect>
                    </label>
                    <label>
                      Новая папка закладок (необязательно)
                      <input
                        aria-label="Название новой папки закладок"
                        maxLength={250}
                        placeholder="Введите название, чтобы сохранить закладку в новую папку"
                        value={editor.newFolder || ""}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            newFolder: event.target.value,
                          })
                        }
                      />
                    </label>
                  </>
                )}
                {error && (
                  <p role="alert" className="favorites-error">
                    {error}
                  </p>
                )}
              </form>
            </Modal>
          </div>,
          document.body,
        )}
    </>
  );
}
