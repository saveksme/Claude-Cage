import { api, native, nativeAvailable } from "./api";

export const imageLimit = 20 * 1024 * 1024;
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function transferFiles(data) {
  const files = Array.from(data?.files || []);
  if (files.length) return files;
  return Array.from(data?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

export function hasFiles(data) {
  return (
    Array.from(data?.types || []).includes("Files") ||
    transferFiles(data).length > 0
  );
}

export async function imagePayload(file) {
  if (!imageTypes.has(file.type))
    throw new Error("Выберите изображение PNG, JPEG, WebP или GIF");
  if (!file.size || file.size > imageLimit)
    throw new Error("Каждое изображение не должно превышать 20 МБ");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () =>
        reject(new Error("Не удалось прочитать изображение. Скопируйте или выберите его заново"));
      image.src = url;
    });
    if (image.naturalWidth * image.naturalHeight > 40_000_000)
      throw new Error("Изображение не должно превышать 40 млн пикселей");
    // Normalize host bitmap formats and animated images to one PNG frame.
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    const png = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png || png.size > imageLimit)
      throw new Error("Преобразованное изображение превышает 20 МБ. Уменьшите его и повторите попытку");
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ png: reader.result.split(",")[1] });
      reader.onerror = () => reject(new Error("Не удалось прочитать изображение"));
      reader.readAsDataURL(png);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function readClipboardContent() {
  if (nativeAvailable()) {
    const value = await native("clipboardReadContent");
    if (
      !value ||
      (typeof value.png !== "string" && typeof value.text !== "string" && typeof value.fileSelection !== "string")
    )
      throw new Error("Не удалось прочитать буфер обмена. Заново откройте новую версию Cage и повторите попытку");
    return value;
  }
  if (navigator.clipboard.read) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((type) => imageTypes.has(type));
      if (type) return imagePayload(await item.getType(type));
    }
    for (const item of items) {
      if (item.types.includes("text/plain"))
        return { text: await (await item.getType("text/plain")).text() };
    }
    throw new Error("В буфере обмена нет изображения или текста для вставки");
  }
  return { text: await navigator.clipboard.readText() };
}

export function prepareClipboardPaste(target, id, { windowTarget, valid = () => true } = {}) {
  let disposed = false, sent = false;
  const destination = { target, id, pid: windowTarget?.pid, window: windowTarget?.window };
  const check = () => {
    if (disposed || !valid()) throw new Error("Место вставки изменилось. Вставьте заново");
  };
  const prepared = api("/input/paste/start", destination).then(result => {
    if (result?.available !== true || typeof result.transfer !== "string" && typeof result.context !== "string")
      throw new Error("Гостевая система ещё не подтвердила место вставки. Синхронизируйте компоненты среды и повторите попытку");
    return { transfer: result.transfer, context: result.context };
  });
  // Source reading starts independently. A sender using this binding observes
  // preparation errors, and every content path disposes its preparation.
  void prepared.catch(() => {});
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    void prepared.then(binding => api("/input/paste/cancel", { ...destination, ...binding })).catch(() => {});
  };
  return {
    async send(payload) {
      check();
      const binding = await prepared;
      check();
      if (sent) throw new Error("Эта вставка уже отправлена. Проверьте результат приёма");
      sent = true;
      try { return await api(typeof payload.text === "string" ? "/input/text" : "/input/image", { ...payload, ...destination, ...binding }); }
      finally { dispose(); }
    },
    dispose,
  };
}

export const sendImage = (payload, target, id, options = {}) =>
  (options.prepared || prepareClipboardPaste(target, id, options)).send(payload);
