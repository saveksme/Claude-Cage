using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Cage.Windows;

internal sealed class MainWindow : Form
{
    private WebView2 web = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly NativeInput nativeInput;
    private readonly Label message = new() { AutoSize = true, MaximumSize = new Size(720, 0), Text = "Запуск рабочей среды Cage…", Margin = new Padding(12) };
    private readonly FlowLayoutPanel status = new() { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(48), WrapContents = false };
    private readonly Button retry = new() { Text = "Повторить подключение", AutoSize = true, Visible = false };
    private readonly Button existing = new() { Text = "Открыть существующую среду", AutoSize = true, Visible = false };
    private readonly Button complete = new() { Text = "Остановить среду после сохранения и завершить обновление", AutoSize = true, Visible = false };
    private readonly NotifyIcon tray;
    private readonly AppUpdater updater;
    private int expectedPort;
    private bool controllerNeedsUpdate, allowQuit, bootstrapping, webFailed;
    private bool completingSmoke;
    private string smokePhase = "starting";
    private readonly CancellationTokenSource lifetime = new();
    private readonly Dictionary<string, (string[] Paths, DateTime Expires)> fileSelections = new();

    public MainWindow()
    {
        nativeInput = new NativeInput(value => Script("window.dispatchEvent(new CustomEvent('cage-native-input',{detail:" + JsonSerializer.Serialize(value) + "}));"));
        AutoScaleMode = AutoScaleMode.Dpi; AutoScaleDimensions = new SizeF(96, 96);
        Text = "Cage";
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(247, 247, 247);
        Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? SystemIcons.Application;
        status.Controls.AddRange([message, retry, existing, complete]);
        Controls.Add(web); Controls.Add(status);
        Controls.Add(nativeInput);
        retry.Click += async (_, _) => {
            if (webFailed || web.CoreWebView2 == null) await Initialize(true); else await Bootstrap();
        };
        existing.Click += async (_, _) => await Bootstrap("--existing");
        complete.Click += async (_, _) => {
            if (ConfirmStop()) await Bootstrap("--complete-update");
        };
        var trayMenu = new TrayMenu();
        trayMenu.Items.Add("Открыть Cage", null, (_, _) => RestoreWindow());
        trayMenu.Items.Add("О Cage", null, (_, _) => MessageBox.Show(this, $"Cage {AppUpdater.Version}\nЛокальная изолированная рабочая среда для программирования", "О Cage"));
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add("Выйти из Cage…", null, (_, _) => RequestQuit());
        trayMenu.Opening += (_, _) => (chrome ?? new WindowChrome(BackColor, ForeColor, false)).ApplyMenu(trayMenu);
        tray = new NotifyIcon { Icon = Icon, Text = "Cage", Visible = true, ContextMenuStrip = trayMenu };
        tray.DoubleClick += (_, _) => RestoreWindow();
        updater = new AppUpdater(PublishUpdate, () => { allowQuit = true; Close(); }, () => _ = Bootstrap());
        Shown += async (_, _) => {
            if (Program.SmokeOutput != null) _ = SmokeDeadline();
            await Initialize();
        };
        Resize += (_, _) => PublishVisibility(); VisibleChanged += (_, _) => PublishVisibility();
        FormClosing += (_, e) => {
            SaveWindowPlacement();
            if (!allowQuit && e.CloseReason is not (CloseReason.WindowsShutDown or CloseReason.TaskManagerClosing)) { e.Cancel = true; Hide(); }
        };
        FormClosed += (_, _) => { lifetime.Cancel(); updater.Dispose(); tray.Dispose(); trayMenu.Dispose(); web.Dispose(); };
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        WindowPlacement? saved = null;
        try { saved = JsonSerializer.Deserialize<WindowPlacement>(File.ReadAllText(Path.Combine(Backend.Root, "window-placement.json"))); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { }
        var work = Screen.FromHandle(Handle).WorkingArea;
        MinimumSize = WindowLayout.Minimum(work, DeviceDpi);
        StartPosition = FormStartPosition.Manual;
        Bounds = WindowLayout.Bounds(work, DeviceDpi, saved);
        if (saved?.Maximized == true) WindowState = FormWindowState.Maximized;
    }

    private void SaveWindowPlacement()
    {
        var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        if (bounds.Width <= 0 || bounds.Height <= 0) return;
        try
        {
            Directory.CreateDirectory(Backend.Root);
            File.WriteAllText(Path.Combine(Backend.Root, "window-placement.json"),
                JsonSerializer.Serialize(new WindowPlacement(bounds.X, bounds.Y, bounds.Width, bounds.Height, DeviceDpi,
                    WindowState == FormWindowState.Maximized)));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        var action = keyData switch {
            Keys.Control | Keys.O => "openProject",
            Keys.Control | Keys.T => "newTab",
            Keys.Control | Keys.Shift | Keys.Enter => "newTerminal",
            Keys.Control | Keys.W => "closeTab",
            Keys.Control | Keys.Oemcomma => "settings",
            _ => null,
        };
        if (action == null) return base.ProcessCmdKey(ref msg, keyData);
        Action(action); return true;
    }

    private WindowChrome? chrome;

    private void ApplyWindowChrome()
    {
        if (IsHandleCreated)
            chrome?.Apply(Handle, MainMenuStrip);
        if (tray?.ContextMenuStrip != null)
            chrome?.ApplyMenu(tray.ContextMenuStrip);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyWindowChrome();
    }

    protected override void OnSystemColorsChanged(EventArgs e)
    {
        base.OnSystemColorsChanged(e);
        ApplyWindowChrome();
    }

    private bool ConfirmStop() => MessageBox.Show(this,
        "Сначала сохраните файлы в редакторе и завершите выполняющиеся задачи. После продолжения Cage остановит среду, установит проверенное обновление и перезапустится.",
        "Сохранить, остановить среду и установить обновление", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) == DialogResult.OK;

    public void RestoreWindow() { Show(); if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Activate(); PublishVisibility(); }
    private void RequestQuit()
    {
        RestoreWindow();
        if (web.Visible) Action("quit");
        else { allowQuit = true; Close(); }
    }
    private void Action(string name) => Script("window.cageNativeAction?.(" + JsonSerializer.Serialize(name) + ")");
    private void PublishVisibility() => Script($"window.cageWindowVisible = {(Visible && WindowState != FormWindowState.Minimized ? "true" : "false")}; window.dispatchEvent(new Event('cage-window-visibility'));");
    private void PublishUpdate(Dictionary<string, object?> state) {
        if (state.TryGetValue("phase", out var phase) && phase as string == "failed") _ = Backend.Report("App update failed: " + state.GetValueOrDefault("message"));
        Script("window.dispatchEvent(new CustomEvent('cage-app-update',{detail:" + JsonSerializer.Serialize(state) + "}));");
    }
    private async void Script(string script)
    {
        if (web.IsDisposed || web.CoreWebView2 == null || IsDisposed) return;
        try { await web.ExecuteScriptAsync(script); }
        catch (InvalidOperationException) { }
        catch (System.Runtime.InteropServices.COMException) { }
    }
    private void Error(string text)
    {
        _ = Backend.Report(text);
        message.Text = text; status.Show(); status.BringToFront(); retry.Show(); web.Hide();
    }

    private async Task Initialize(bool recreate = false)
    {
        smokePhase = "initializing_webview";
        retry.Enabled = false;
        try
        {
            if (recreate)
            {
                Controls.Remove(web); web.Dispose();
                web = new WebView2 { Dock = DockStyle.Fill, Visible = false };
                Controls.Add(web); status.BringToFront();
            }
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Backend.Root, "webview2"));
            await web.EnsureCoreWebView2Async(environment);
            smokePhase = "webview_initialized";
            var core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false; core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false; core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false; core.Settings.IsGeneralAutofillEnabled = false;
            core.NavigationStarting += (_, e) => { if (!UpdatePolicy.IsWorkbench(e.Uri, expectedPort)) e.Cancel = true; };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.WebMessageReceived += Receive;
            core.ProcessFailed += (_, _) => { webFailed = true; Error("Процесс отображения рабочей среды завершился. Фоновые задачи сохранены; подключение можно повторить."); };
            core.NavigationCompleted += (_, e) => {
                if (!e.IsSuccess) {
                    var reason = e.WebErrorStatus.ToString() switch {
                        "Timeout" => "локальная фоновая служба не ответила за отведённое время",
                        "CannotConnect" => "локальная фоновая служба не приняла подключение: возможно, она ещё не запустилась или уже завершилась",
                        "ConnectionAborted" or "ConnectionReset" => "подключение к локальной рабочей среде прервалось до завершения загрузки",
                        _ => "встроенный веб-компонент не смог загрузить локальную рабочую среду (тип ошибки " + e.WebErrorStatus + ")",
                    };
                    Error("Не удалось открыть рабочую среду: " + reason + ". Нажмите «Повторить подключение»; если ошибка повторится, сохраните это сообщение и сообщите о ней сопровождающему. Фоновые задачи при этом не завершатся автоматически."); return;
                }
                status.Hide(); web.Show(); web.Focus(); PublishVisibility();
            };
            await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);
            if (Program.SmokeOutput != null) await core.AddScriptToExecuteOnDocumentCreatedAsync(SmokeDiagnosticsScript);
            webFailed = false;
            await Bootstrap();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Error("Не найден Microsoft Edge WebView2 Runtime. Запустите установщик Cage, установите встроенную среду выполнения и повторите попытку.");
            webFailed = true;
        }
        catch (Exception error) { webFailed = true; Error("Не удалось инициализировать рабочую среду: " + error.Message); }
        finally { retry.Enabled = true; }
    }

    private async Task SmokeDeadline()
    {
        try { await Task.Delay(TimeSpan.FromSeconds(120), lifetime.Token); await CompleteSmoke(false, "Рабочая среда не подтвердила готовность за отведённое для самопроверки время"); }
        catch (OperationCanceledException) { }
    }

    private async Task CompleteSmoke(bool nativeBridgeReady = true, string? failure = null)
    {
        if (Program.SmokeOutput == null || completingSmoke) return;
        completingSmoke = true;
        JsonElement? page = null;
        var pageURL = web.Source?.GetLeftPart(UriPartial.Path);
        var core = web.CoreWebView2;
        var environment = core?.Environment;
        var webviewVersion = environment?.BrowserVersionString;
        using var shutdown = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        shutdown.CancelAfter(TimeSpan.FromSeconds(20));
        var errors = new List<string>();
        var localizationProblems = new List<string>();
        var russianUI = false;
        int? prepareExit = null;
        string? prepareStatus = null;
        if (failure != null) errors.Add(failure);
        try
        {
            // Capture the real document before stopping anything, including on
            // failure paths where the bridge never became ready.
            if (core != null)
            {
                try
                {
                    var snapshot = await core.ExecuteScriptAsync("""
                        (() => {
                          const text = document.body?.innerText || '';
                          return {
                            title: document.title,
                            ready: document.readyState,
                            lang: (document.documentElement?.lang || '').trim().toLowerCase(),
                            cyrillic: /\p{Script=Cyrillic}/u.test(text),
                            han: /\p{Script=Han}/u.test(text),
                            text: text.slice(0, 4096),
                            errors: window.__cageSmokeErrors || [],
                          };
                        })()
                        """);
                    using var document = JsonDocument.Parse(snapshot);
                    page = document.RootElement.Clone();
                    var documentState = page.Value;
                    var lang = documentState.Text("lang");
                    var cyrillic = documentState.TryGetProperty("cyrillic", out var cyrillicValue) && cyrillicValue.ValueKind == JsonValueKind.True;
                    var han = documentState.TryGetProperty("han", out var hanValue) && hanValue.ValueKind == JsonValueKind.True;
                    russianUI = lang == "ru" && cyrillic && !han;
                    if (lang != "ru") localizationProblems.Add(lang.Length == 0 ? "в документе не указан язык lang=\"ru\"" : "язык документа «" + lang + "» вместо «ru»");
                    if (!cyrillic) localizationProblems.Add("в тексте страницы нет кириллицы");
                    if (han) localizationProblems.Add("в тексте страницы остались иероглифы Han");
                }
                catch (Exception error) { errors.Add("Не удалось прочитать состояние рабочей среды: " + error.Message); }
                try
                {
                    await using var capture = File.Create(Path.ChangeExtension(Program.SmokeOutput, ".png"));
                    await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, capture);
                }
                catch (Exception error) { errors.Add("Не удалось сохранить снимок рабочей среды: " + error.Message); }
            }
            if (nativeBridgeReady && !russianUI)
            {
                if (localizationProblems.Count == 0) localizationProblems.Add("не удалось подтвердить русский текст страницы");
                errors.Add("Русская локализация рабочей среды не подтверждена: " + string.Join("; ", localizationProblems) + ".");
            }
            var controllers = Backend.CaptureSmokeControllers();
            try
            {
                if (nativeBridgeReady) smokePhase = "stopping_backend";
                var (exit, data) = await Backend.Json(["prepare-update", "--json"], shutdown.Token, TimeSpan.FromSeconds(20));
                prepareExit = exit;
                prepareStatus = data.Text("status") is "prepared" or "stop_required" or "error" ? data.Text("status") : "unexpected";
                if (exit != 0 || data.Text("status") != "prepared") throw new IOException("При завершении самопроверки не удалось подтвердить остановку фоновой службы");
                await Task.WhenAll(controllers.Select(process => process.WaitForExitAsync(shutdown.Token)));
            }
            finally { foreach (var process in controllers) process.Dispose(); }
        }
        catch (Exception error) { errors.Add(error.Message); }
        // WebView2 releases its processes asynchronously after Dispose. Its
        // browser can retain the app's working directory until this event.
        if (environment != null)
        {
            var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            void BrowserExited(object? sender, CoreWebView2BrowserProcessExitedEventArgs args) => exited.TrySetResult();
            environment.BrowserProcessExited += BrowserExited;
            try
            {
                if (nativeBridgeReady && errors.Count == 0) smokePhase = "stopping_browser";
                web.Dispose();
                await exited.Task.WaitAsync(shutdown.Token);
            }
            catch (Exception error) { errors.Add("Браузер самопроверки не завершил работу: " + error.Message); }
            finally { environment.BrowserProcessExited -= BrowserExited; }
        }
        try
        {
            if (nativeBridgeReady && errors.Count == 0) smokePhase = "completed";
            File.WriteAllText(Program.SmokeOutput, JsonSerializer.Serialize(new {
                success = nativeBridgeReady && russianUI && errors.Count == 0, nativeBridgeReady, russianUI, version = AppUpdater.Version,
                phase = smokePhase, nativeStatus = message.Text, prepareExit, prepareStatus, errors, page,
                pageURL, webviewVersion,
                windowBounds = Bounds, workingArea = Screen.FromHandle(Handle).WorkingArea, deviceDpi = DeviceDpi,
                nativeMenuBar = MainMenuStrip != null,
            }));
        }
        catch (Exception error) { Error(error.Message); }
        finally { allowQuit = true; BeginInvoke(Close); }
    }

    private async Task Bootstrap(params string[] options)
    {
        if (bootstrapping || web.CoreWebView2 == null) return;
        bootstrapping = true;
        message.Text = "Подключение к рабочей среде Cage…"; status.Show(); status.BringToFront();
        retry.Hide(); existing.Hide(); complete.Hide();
        try
        {
            smokePhase = "starting_backend";
            var (exit, data) = await Backend.Json(["desktop", "--json", ..options], lifetime.Token);
            smokePhase = "backend_returned";
            if (exit != 0) throw new IOException(data.Text("message") is { Length: > 0 } detail ? detail : "Не удалось запустить рабочую среду");
            controllerNeedsUpdate = data.Text("status") != "ready";
            if (data.Text("status") == "upgrade_pending")
            {
                message.Text = data.Text("message"); existing.Show(); complete.Show(); return;
            }
            var entry = UpdatePolicy.Entry(data.Text("url")); expectedPort = entry.Port;
            smokePhase = "loading_workbench";
            Text = controllerNeedsUpdate ? "Cage (обновление не завершено)" : "Cage";
            web.CoreWebView2.Navigate(entry.AbsoluteUri);
        }
        catch (OperationCanceledException) { if (!lifetime.IsCancellationRequested) Error("Не удалось запустить рабочую среду: локальная фоновая служба не ответила за отведённое время. Нажмите «Повторить подключение»; если ошибка повторится, сохраните это сообщение и сообщите о ней сопровождающему."); }
        catch (Exception error) {
            _ = Backend.Report("Workbench startup failed: " + error);
            Error(error.Message.Any(c => c is >= '\u0400' and <= '\u04FF') ? error.Message : "Не удалось запустить рабочую среду: локальная фоновая служба не вернула распознаваемую причину (тип ошибки " + error.GetType().Name + "). Нажмите «Повторить подключение»; если ошибка повторится, сохраните это сообщение и сообщите о ней сопровождающему.");
        }
        finally { bootstrapping = false; }
    }

    private object RememberFiles(string[] paths)
    {
        if (paths.Length is 0 or > 100) throw new InvalidDataException("Выберите от 1 до 100 файлов");
        foreach (var path in paths)
        {
            if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal)) throw new InvalidDataException("Выберите локальный файл");
            var file = new FileInfo(path);
            if (!file.Exists || (file.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                throw new InvalidDataException("Выберите обычный файл; папки и ссылки пока не поддерживаются");
            if (file.Length > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("Размер каждого файла не должен превышать 2 ГБ");
        }
        var now = DateTime.UtcNow;
        foreach (var key in fileSelections.Where(item => item.Value.Expires <= now).Select(item => item.Key).ToArray()) fileSelections.Remove(key);
        if (fileSelections.Count >= 16) fileSelections.Remove(fileSelections.MinBy(item => item.Value.Expires).Key);
        var selection = Guid.NewGuid().ToString();
        fileSelections[selection] = (paths, now.AddMinutes(10));
        return new { fileSelection = selection, count = paths.Length };
    }

    private async void Receive(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // CoreWebView2.WebMessageReceived is top-document only. Frame messages
        // have a separate CoreWebView2Frame event, which this host never handles.
        if (!UpdatePolicy.IsWorkbench(e.Source, expectedPort)) return;
        string id = "";
        try
        {
            var message = e.WebMessageAsJson;
            using var envelope = JsonDocument.Parse(message);
            var body = envelope.RootElement;
            id = body.Text("id");
            if (!Guid.TryParse(id, out _)) return;
            // Match the Linux bridge envelope limit. A 20 MiB PNG needs about
            // 27 MiB after Base64 encoding; retain the ID to reply on rejection.
            if (message.Length > 30 * 1024 * 1024) throw new InvalidDataException("Запрос слишком велик. Уменьшите размер изображения или текста и повторите попытку");
            var request = body.GetProperty("request");
            object? result;
            switch (request.Text("action"))
            {
                case "remoteInput": result = nativeInput.ProcessRequest(request, web, web.ZoomFactor); break;
                case "exportDiagnostics":
                    using (var picker = new SaveFileDialog { Title = "Экспорт диагностики", Filter = "Пакет диагностики (*.zip)|*.zip", FileName = "cage-diagnostics.zip", DefaultExt = "zip", AddExtension = true })
                    {
                        if (picker.ShowDialog(this) != DialogResult.OK) { result = new { canceled = true }; break; }
                        var connection = request.Text("connection_id");
                        var exported = await Backend.Json(["diagnostics", "--json", "--connection", string.IsNullOrEmpty(connection) ? "local" : connection, picker.FileName], lifetime.Token, TimeSpan.FromSeconds(60));
                        if (exported.Exit != 0) throw new IOException(exported.Data.Text("message"));
                        result = exported.Data;
                    }
                    break;
                case "workbenchReady":
                    if (controllerNeedsUpdate) throw new IOException("Версия фоновой службы ещё не синхронизирована; обновление не завершено");
                    updater.MarkReady(); result = true; _ = CompleteSmoke(); break;
                case "appUpdate":
                    result = new {
                        phase = "manual", available = false, currentVersion = AppUpdater.Version,
                        message = "Обновление приложения отключено в этой сборке. Новые версии устанавливаются вручную."
                    };
                    break;
                case "importTheme":
                    using (var picker = new OpenFileDialog { Filter = "Тема Cage (*.json)|*.json", Title = "Импорт темы", Multiselect = false })
                    {
                        if (picker.ShowDialog(this) != DialogResult.OK) { result = ""; break; }
                        using var stream = File.OpenRead(picker.FileName);
                        if (stream.Length > 256 * 1024) throw new InvalidDataException("Файл темы не должен превышать 256 КБ");
                        using var reader = new StreamReader(stream, new System.Text.UTF8Encoding(false, true));
                        result = reader.ReadToEnd();
                    }
                    break;
                case "exportTheme":
                    var themeText = request.Text("text");
                    if (System.Text.Encoding.UTF8.GetByteCount(themeText) > 256 * 1024) throw new InvalidDataException("Файл темы не должен превышать 256 КБ");
                    var themeDocument = JsonDocument.Parse(themeText).RootElement;
                    if (themeDocument.Text("format") != "cage-theme" || themeDocument.GetProperty("version").GetInt32() != 1) throw new InvalidDataException("Недопустимый формат файла темы");
                    using (var picker = new SaveFileDialog { Filter = "Тема Cage (*.json)|*.json", Title = "Экспорт темы", FileName = Path.GetFileName(request.Text("filename")), DefaultExt = "json", AddExtension = true })
                    {
                        if (picker.ShowDialog(this) != DialogResult.OK) { result = false; break; }
                        File.WriteAllText(picker.FileName, themeText, new System.Text.UTF8Encoding(false)); result = true;
                    }
                    break;
                case "shareLocalProject":
                {
                    var connection = request.Text("connection_id");
                    var accessMode = request.Text("mode");
                    if (connection.Length == 0 || accessMode is not ("read" or "write")) throw new InvalidDataException("Выберите проект заново в облачной рабочей среде");
                    using var picker = new FolderBrowserDialog {
                        Description = accessMode == "write" ? "Облачный Cage сможет читать, изменять и удалять файлы в выбранном проекте." : "Облачный Cage сможет читать файлы в выбранном проекте.",
                        UseDescriptionForTitle = true, ShowNewFolderButton = false
                    };
                    if (picker.ShowDialog(this) != DialogResult.OK) { result = new { canceled = true }; break; }
                    var response = await Backend.Json(["share-project", "--json", "--connection", connection, accessMode, picker.SelectedPath], lifetime.Token, TimeSpan.FromSeconds(90));
                    if (response.Exit != 0) throw new IOException(response.Data.Text("message"));
                    result = response.Data; break;
                }
                case "chooseFolder":
                    using (var picker = new FolderBrowserDialog { Description = request.Text("purpose") == "environmentStorage" ? "Выберите пустую папку для образов и виртуальных дисков." : "С Cage будет доступна только эта папка. Выберите конкретный проект.", UseDescriptionForTitle = true, ShowNewFolderButton = true })
                        result = picker.ShowDialog(this) == DialogResult.OK ? picker.SelectedPath : "";
                    break;
                case "clipboardRead": result = Clipboard.ContainsText() ? Clipboard.GetText() : ""; break;
                case "clipboardRevision": result = SharedClipboard.Revision; break;
                case "clipboardSyncCancel": SharedClipboard.Cancel(); result = true; break;
                case "clipboardSyncRead": result = await SharedClipboard.Read(request, lifetime.Token); break;
                case "clipboardSyncWrite": result = await SharedClipboard.Write(request, lifetime.Token); break;
                case "clipboardSyncRelease": result = await SharedClipboard.Release(request, lifetime.Token); break;
                case "desktopFileAction":
                {
                    var fileRequestID = request.Text("id");
                    if (!Guid.TryParse(fileRequestID, out _)) throw new InvalidDataException("Недопустимый идентификатор файла");
                    var connection = request.Text("connection_id");
                    var response = await Backend.Json(["desktop-file", "--json", "--connection", string.IsNullOrEmpty(connection) ? "local" : connection, fileRequestID], lifetime.Token, TimeSpan.FromMinutes(30));
                    if (response.Exit != 0) throw new IOException(response.Data.Text("message"));
                    result = response.Data; break;
                }
                case "saveBrowserDownload":
                case "browserDownloadAction":
                {
                    var downloadID = request.Text("id");
                    if (!Guid.TryParse(downloadID, out _)) throw new InvalidDataException("Недопустимый идентификатор загрузки");
                    var operation = request.Text("action") == "saveBrowserDownload" ? "save" : request.Text("operation");
                    if (operation is not ("save" or "open" or "reveal")) throw new InvalidDataException("Недопустимая операция с загрузкой");
                    var connection = request.Text("connection_id");
                    var arguments = new List<string> { "browser-file", "--json", "--connection", string.IsNullOrEmpty(connection) ? "local" : connection, operation, downloadID };
                    if (operation == "save")
                    {
                        var fileName = Path.GetFileName(request.Text("name"));
                        foreach (var character in Path.GetInvalidFileNameChars()) fileName = fileName.Replace(character, '_');
                        using var picker = new SaveFileDialog { Title = "Сохранить загрузку на этот компьютер", FileName = fileName, OverwritePrompt = true, AddExtension = false };
                        if (picker.ShowDialog(this) != DialogResult.OK) { result = new { canceled = true }; break; }
                        arguments.Add(picker.FileName);
                    }
                    var response = await Backend.Json(arguments.ToArray(), lifetime.Token, TimeSpan.FromMinutes(30));
                    if (response.Exit != 0) throw new IOException(response.Data.Text("message"));
                    result = response.Data; break;
                }
                case "clipboardReadContent":
                    if (Clipboard.ContainsFileDropList()) result = RememberFiles(Clipboard.GetFileDropList().Cast<string>().ToArray());
                    else if (Clipboard.ContainsImage())
                    {
                        using var clipboardImage = Clipboard.GetImage() ?? throw new InvalidDataException("Не удалось прочитать изображение из буфера обмена");
                        if ((long)clipboardImage.Width * clipboardImage.Height > 40_000_000) throw new InvalidDataException("Размер изображения не должен превышать 40 млн пикселей");
                        using var imageStream = new MemoryStream();
                        clipboardImage.Save(imageStream, System.Drawing.Imaging.ImageFormat.Png);
                        if (imageStream.Length > 20 * 1024 * 1024) throw new InvalidDataException("Размер изображения не должен превышать 20 МБ");
                        result = new { png = Convert.ToBase64String(imageStream.ToArray()) };
                    }
                    else result = new { text = Clipboard.ContainsText() ? Clipboard.GetText() : "" };
                    break;
                case "chooseGuestMedia":
                    using (var picker = new OpenFileDialog { Title = "Выберите установочный образ Windows 11 x64", Filter = "Windows ISO (*.iso)|*.iso", Multiselect = false })
                        result = picker.ShowDialog(this) == DialogResult.OK ? picker.FileName : "";
                    break;
                case "guestInstallReference":
                    var reference = request.Text("kind") switch {
                        "windows-media" => "https://www.microsoft.com/software-download/windows11",
                        "editor-license" => "https://aka.ms/vscode-server-license",
                        _ => throw new InvalidDataException("Неизвестная справочная страница установки")
                    };
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(reference) { UseShellExecute = true });
                    result = true; break;
                case "chooseUploadFiles":
                    using (var picker = new OpenFileDialog { Title = "Выберите файлы на этом компьютере", Multiselect = request.TryGetProperty("multiple", out var multiple) && multiple.ValueKind == JsonValueKind.True, CheckFileExists = true })
                        result = picker.ShowDialog(this) == DialogResult.OK ? RememberFiles(picker.FileNames) : new { canceled = true };
                    break;
                case "uploadHostFiles":
                {
                    var target = request.Text("target");
                    var uploadID = request.Text("id");
                    if (target is not ("browser" or "desktop" or "terminal") || !(target == "terminal" ? System.Text.RegularExpressions.Regex.IsMatch(uploadID, "^[a-f0-9]{16}$") : Guid.TryParse(uploadID, out _))) throw new InvalidDataException("Недопустимая цель загрузки файлов");
                    if (!fileSelections.Remove(request.Text("selection"), out var selected) || selected.Expires <= DateTime.UtcNow)
                        throw new InvalidDataException("Срок выбора файлов истёк. Скопируйте или выберите файлы заново");
                    var connection = request.Text("connection_id");
                    var arguments = new List<string> { "upload-files", "--json", "--connection", string.IsNullOrEmpty(connection) ? "local" : connection, target, uploadID };
                    arguments.AddRange(selected.Paths);
                    var response = await Backend.Json(arguments.ToArray(), lifetime.Token, TimeSpan.FromMinutes(30));
                    if (response.Exit != 0) throw new IOException(response.Data.Text("message"));
                    result = response.Data;
                    break;
                }
                case "clipboardWrite":
                    if (request.Text("text") is { Length: > 0 } text) Clipboard.SetText(text); else Clipboard.Clear();
                    result = true; break;
                case "appearance":
                    var mode = request.Text("mode"); var background = request.Text("background");
                    if (mode is not ("system" or "light" or "dark") || !System.Text.RegularExpressions.Regex.IsMatch(background, "^#[0-9a-fA-F]{6}$"))
                        throw new InvalidDataException("Недопустимые параметры оформления");
                    var foreground = request.Text("foreground");
                    BackColor = ColorTranslator.FromHtml(background); web.DefaultBackgroundColor = BackColor;
                    var ink = System.Text.RegularExpressions.Regex.IsMatch(foreground, "^#[0-9a-fA-F]{6}$")
                        ? ColorTranslator.FromHtml(foreground) : WindowChrome.ContrastingText(BackColor);
                    chrome = new WindowChrome(BackColor, ink, request.Text("variant") == "dark");
                    ApplyWindowChrome();
                    web.CoreWebView2.Profile.PreferredColorScheme = mode == "dark" ? CoreWebView2PreferredColorScheme.Dark : mode == "light" ? CoreWebView2PreferredColorScheme.Light : CoreWebView2PreferredColorScheme.Auto;
                    result = true; break;
                case "accountDevice":
                    if (request.Text("operation") != "status") throw new InvalidDataException("Быстрый вход на этой платформе пока не поддерживается");
                    result = new { supported = false }; break;
                case "refreshSession":
                    var (exit, data) = await Backend.Json(controllerNeedsUpdate ? ["desktop", "--json", "--existing"] : ["desktop", "--json"], lifetime.Token);
                    if (exit != 0) throw new IOException("Не удалось восстановить сеанс рабочей среды");
                    result = new { url = UpdatePolicy.Entry(data.Text("url")).AbsoluteUri }; break;
                case "reconnect": result = true; _ = Bootstrap(); break;
                case "quitNow": result = true; allowQuit = true; BeginInvoke(Close); break;
                default: throw new InvalidDataException("Неизвестная нативная операция");
            }
            if (!web.IsDisposed) web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, result }));
        }
        catch (Exception error)
        {
            _ = Backend.Report(error.ToString());
            if (id.Length != 0 && !IsDisposed && !web.IsDisposed) web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, error = error.Message }));
        }
    }

    private const string SmokeDiagnosticsScript = """
        (() => {
          if (window !== window.top || location.protocol !== 'http:' || location.hostname !== 'localhost') return;
          const errors = [];
          Object.defineProperty(window, '__cageSmokeErrors', { value: errors });
          const ownPath = value => {
            try { const url = new URL(value, location.href); return url.origin === location.origin ? url.pathname : ''; }
            catch { return ''; }
          };
          const scrub = value => {
            let text = String(value || '');
            for (const input of document.querySelectorAll('input,textarea'))
              if (input.value) text = text.split(input.value).join('[form-value]');
            return text.replace(/https?:\/\/[^\s"'<>`]+/g, value => ownPath(value) || '[external]')
              .replace(/[?#][^\s"'<>)]*/g, '[redacted]').slice(0, 768);
          };
          const stack = error => String(error?.stack || '').split('\n').slice(1)
            .filter(line => line.includes(location.origin + '/')).slice(0, 6).map(scrub);
          const record = value => { if (errors.length < 8) errors.push(value); };
          addEventListener('error', event => {
            if (event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement) {
              const source = ownPath(event.target.src || event.target.href);
              if (source) record({ type: 'module-load', source });
              return;
            }
            const source = ownPath(event.filename || location.href);
            if (source) record({ type: 'error', source, message: scrub(event.message), stack: stack(event.error) });
          }, true);
          addEventListener('unhandledrejection', event => {
            const frames = stack(event.reason);
            // Primitive/cross-origin rejections are counted without exporting arbitrary values.
            record({ type: 'unhandledrejection', message: frames.length ? scrub(event.reason?.message) : 'Unhandled rejection', stack: frames });
          });
        })();
        """;

    private const string BridgeScript = """
        (() => {
          if (window !== window.top || location.protocol !== 'http:' || location.hostname !== 'localhost') return;
          window.cageNativeIMEAvailable = true;
          const pending = new Map();
          const fileActions = new Set([
            'uploadHostFiles', 'chooseUploadFiles', 'clipboardSyncRead', 'clipboardSyncWrite',
            'saveBrowserDownload', 'browserDownloadAction', 'desktopFileAction', 'exportDiagnostics',
            'importTheme', 'exportTheme', 'shareLocalProject', 'chooseFolder', 'chooseGuestMedia',
          ]);
          chrome.webview.addEventListener('message', ({data}) => {
            const item = pending.get(data.id); if (!item) return;
            pending.delete(data.id); clearTimeout(item.timer);
            data.error ? item.reject(new Error(data.error)) : item.resolve(data.result);
          });
          const cage = {postMessage(request) { return new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            // File commands have a 30-minute backend deadline. Leave time for
            // the native file dialog and the final subprocess response.
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('Нативная операция не завершилась вовремя. Повторите попытку')); }, fileActions.has(request.action) ? 3600000 : 240000);
            pending.set(id, {resolve, reject, timer}); chrome.webview.postMessage({id, request});
          }); }};
          Object.defineProperty(window, 'webkit', {value: {messageHandlers: {cage}}, writable: false});
        })();
        """;
}
