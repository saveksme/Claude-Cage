import test from "node:test";
import assert from "node:assert/strict";
import {
  httpErrorMessage,
  connectionErrorMessage,
  nativeFailureMessage,
} from "./error-message.mjs";

test("HTTP failures name the operation and avoid upstream HTML or opaque runtime output", () => {
  for (const [status, reason] of [
    [401, "Сеанс"],
    [409, "операция"],
    [413, "размер"],
    [503, "ещё не готов"],
    [504, "время ожидания"],
  ]) {
    const message = httpErrorMessage(
      "/environment/resources",
      status,
      "<html>token=private</html>",
      "text/html",
    );
    assert.match(message, /конфигурации ресурсов/);
    assert.ok(message.includes(reason));
    assert.ok(!message.includes("private"));
  }
  const specific =
    "Окно загрузки закрыто. Нажмите кнопку загрузки на веб-странице ещё раз.";
  assert.equal(
    httpErrorMessage("/input/files", 409, specific, "text/plain; charset=utf-8"),
    specific,
  );
  for (const sensitive of [
    "Не удалось открыть C:\\Users\\Иван\\private-secret",
    "Ошибка авторизации: token=private-secret",
  ]) {
    const message = httpErrorMessage("/input/files", 409, sensitive, "text/plain; charset=utf-8");
    assert.ok(!message.includes("private-secret"));
    assert.ok(!message.includes("Иван"));
  }
  assert.doesNotMatch(
    httpErrorMessage(
      "/input/files",
      409,
      "上传窗口已关闭，请重新点击网页上传按钮",
      "text/plain; charset=utf-8",
    ),
    /\p{Script=Han}/u,
  );
  assert.match(
    connectionErrorMessage("/input/files"),
    /передача файлов.*соединение.*прервано.*проверьте результат/i,
  );
  assert.match(
    httpErrorMessage("/settings", 503, "", "", "POST"),
    /подтвердить, сохранены ли настройки.*сверьте настройки/,
  );
});

test("native errors retain precise rules and explain opaque failures in context", () => {
  assert.match(
    nativeFailureMessage("exportDiagnostics", "Native operation timeout"),
    /экспорт пакета диагностики.*истекло время ожидания/,
  );
  assert.match(
    nativeFailureMessage("uploadHostFiles", "operation failed token=private"),
    /загрузка файлов с этого компьютера.*распознаваемую причину/,
  );
  assert.ok(
    !nativeFailureMessage(
      "uploadHostFiles",
      "operation failed token=private",
    ).includes("private"),
  );
  const rule = "Выберите файл в папке проекта на этом компьютере";
  assert.equal(nativeFailureMessage("uploadHostFiles", rule), rule);
  assert.doesNotMatch(
    nativeFailureMessage("uploadHostFiles", "请选择本机项目中的文件"),
    /\p{Script=Han}/u,
  );
  for (const sensitive of [
    "Не удалось открыть C:\\Users\\Иван\\private-secret",
    "Ошибка авторизации: token=private-secret",
  ]) {
    const message = nativeFailureMessage("uploadHostFiles", sensitive);
    assert.ok(!message.includes("private-secret"));
    assert.ok(!message.includes("Иван"));
  }
});
