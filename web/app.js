// Front-end do MVP: autosave do formulário + upload de anexos via API (/api → Azure Functions).

const API = "/api";
const SAVE_DELAY_MS = 700;      // espera o usuário parar de digitar antes de salvar
const POLL_MS = 10000;          // atualiza a lista (e o registro aberto) a cada 10 s
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;

const $ = (sel) => document.querySelector(sel);
const form = $("#form");
const saveStatus = $("#save-status");
const apiStatus = $("#api-status");
const formTitle = $("#form-title");
const recordList = $("#record-list");
const listEmpty = $("#list-empty");
const dropZone = $("#drop-zone");
const fileInput = $("#file-input");
const fileMsg = $("#file-msg");
const fileList = $("#file-list");
const btnNew = $("#btn-new");
const btnDelete = $("#btn-delete");

const state = {
  id: null,          // id do registro aberto
  exists: false,     // já foi gravado no Azure?
  updatedAt: null,
  files: [],
  records: [],
};

let pending = null;  // { id, data } aguardando gravação
let saving = null;   // Promise da gravação em andamento
let saveTimer = null;

// ---------- utilidades ----------

async function api(path, options = {}) {
  const res = await fetch(API + path, options);
  // Sessão expirada: o Static Web Apps redireciona para /login.html (ou devolve 401).
  if (res.redirected || res.status === 401) {
    location.href = "/login.html";
    throw new Error("Sessão expirada");
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { message = (await res.json()).error || message; } catch {}
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

function setStatus(text, kind = "idle") {
  saveStatus.textContent = text;
  saveStatus.dataset.kind = kind;
}

function setFileMsg(text, kind = "info") {
  fileMsg.textContent = text;
  fileMsg.dataset.kind = kind;
}

const formatTime = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const formatDateTime = (iso) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const formatSize = (bytes) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const readForm = () => Object.fromEntries(new FormData(form));

function fillForm(record) {
  for (const field of form.elements) {
    if (field.name) field.value = record[field.name] ?? "";
  }
}

// ---------- salvamento automático ----------

form.addEventListener("input", () => {
  pending = { id: state.id, data: readForm() };
  setStatus("Alterações pendentes…", "pending");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
});

async function save() {
  clearTimeout(saveTimer);
  while (saving) await saving;   // grava uma coisa por vez
  if (!pending) return;

  const job = pending;
  pending = null;
  if (job.id === state.id) setStatus("Salvando…", "saving");

  saving = api(`/records/${job.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(job.data),
  })
    .then((record) => {
      if (job.id === state.id) {
        state.exists = true;
        state.updatedAt = record.updatedAt;
        formTitle.textContent = record.nome || "(sem nome)";
        btnDelete.hidden = false;
        setStatus(`Salvo no Azure às ${formatTime(record.updatedAt)}`, "ok");
      }
      refreshList();
    })
    .catch((err) => {
      if (!pending) pending = job;   // mantém para tentar de novo
      if (job.id === state.id) setStatus(`Erro ao salvar (${err.message}). Tentando novamente…`, "error");
      saveTimer = setTimeout(save, 3000);
    })
    .finally(() => { saving = null; });

  return saving;
}

window.addEventListener("beforeunload", (e) => {
  if (pending || saving) e.preventDefault();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") save();
});

// ---------- registros ----------

async function newRecord() {
  await save();
  state.id = crypto.randomUUID();
  state.exists = false;
  state.updatedAt = null;
  state.files = [];
  form.reset();
  formTitle.textContent = "Novo registro";
  btnDelete.hidden = true;
  setStatus("Comece a digitar — o salvamento é automático.");
  setFileMsg("");
  renderFiles();
  renderList();
  form.elements.nome.focus();
}

async function openRecord(id, { silent = false } = {}) {
  if (!silent) await save();
  try {
    const record = await api(`/records/${id}`);
    state.id = record.id;
    state.exists = true;
    state.updatedAt = record.updatedAt;
    state.files = record.files;
    fillForm(record);
    formTitle.textContent = record.nome || "(sem nome)";
    btnDelete.hidden = false;
    setStatus(`${silent ? "Atualizado" : "Carregado"} — última gravação ${formatDateTime(record.updatedAt)}`, "ok");
    if (!silent) setFileMsg("");
    renderFiles();
    renderList();
  } catch (err) {
    setStatus(`Erro ao abrir registro: ${err.message}`, "error");
  }
}

async function deleteRecord() {
  if (!state.exists || !confirm("Excluir este registro e todos os anexos?")) return;
  pending = null;
  clearTimeout(saveTimer);
  while (saving) await saving;
  try {
    await api(`/records/${state.id}`, { method: "DELETE" });
    await refreshList();
    await newRecord();
    setStatus("Registro excluído.", "ok");
  } catch (err) {
    setStatus(`Erro ao excluir: ${err.message}`, "error");
  }
}

async function refreshList() {
  try {
    state.records = await api("/records");
    renderList();
  } catch {
    // o indicador de API já mostra a falha
  }
}

function renderList() {
  recordList.replaceChildren(...state.records.map((r) => {
    const btn = el("button", { type: "button" },
      el("span", { className: "name", textContent: r.nome || "(sem nome)" }),
      el("span", { className: "meta", textContent: [r.categoria, formatDateTime(r.updatedAt), r.updatedBy].filter(Boolean).join(" · ") }),
    );
    btn.setAttribute("aria-current", String(r.id === state.id));
    btn.addEventListener("click", () => openRecord(r.id));
    return el("li", {}, btn);
  }));
  listEmpty.hidden = state.records.length > 0;
}

// Sincronização entre abas/dispositivos: se outro lugar alterou o registro aberto, recarrega.
async function poll() {
  if (document.visibilityState !== "visible") return;
  await refreshList();
  const remote = state.records.find((r) => r.id === state.id);
  const editing = form.contains(document.activeElement);
  if (remote && state.exists && !pending && !saving && !editing && remote.updatedAt !== state.updatedAt) {
    openRecord(state.id, { silent: true });
  }
}

// ---------- anexos ----------

async function uploadFiles(files) {
  const valid = [];
  const errors = [];
  for (const file of files) {
    if (!ALLOWED_TYPES.test(file.type)) errors.push(`${file.name}: tipo não permitido`);
    else if (file.size > MAX_FILE_BYTES) errors.push(`${file.name}: maior que 10 MB`);
    else valid.push(file);
  }
  if (!valid.length) {
    setFileMsg(errors.join(" · "), "error");
    return;
  }

  // O registro precisa existir no Azure antes de receber anexos.
  if (!state.exists) {
    pending ??= { id: state.id, data: readForm() };
    await save();
    if (!state.exists) {
      setFileMsg("Não foi possível criar o registro para anexar os arquivos.", "error");
      return;
    }
  }

  const recordId = state.id;
  let done = 0;
  for (const file of valid) {
    setFileMsg(`Enviando ${done + 1} de ${valid.length}: ${file.name}…`);
    renderFiles([file.name]);
    try {
      const body = new FormData();
      body.append("file", file);
      const uploaded = await api(`/records/${recordId}/files`, { method: "POST", body });
      if (recordId === state.id) state.files.push(uploaded);
      done++;
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  if (recordId === state.id) renderFiles();
  refreshList();
  setFileMsg(
    [`${done} arquivo(s) enviado(s) para o Azure.`, ...errors].join(" · "),
    errors.length ? "error" : "info",
  );
}

async function deleteFile(file) {
  if (!confirm(`Remover "${file.name}"?`)) return;
  try {
    await api(`/records/${state.id}/files/${file.id}`, { method: "DELETE" });
    state.files = state.files.filter((f) => f.id !== file.id);
    renderFiles();
    setFileMsg(`"${file.name}" removido.`);
  } catch (err) {
    setFileMsg(`Erro ao remover: ${err.message}`, "error");
  }
}

function renderFiles(uploadingNames = []) {
  const cards = state.files.map((file) => {
    const url = `${API}/records/${state.id}/files/${file.id}`;
    const thumb = el("a", { className: "thumb", href: url, target: "_blank", rel: "noopener" });
    if (file.type.startsWith("image/")) thumb.append(el("img", { src: url, alt: file.name, loading: "lazy" }));
    else thumb.textContent = "PDF";

    const remove = el("button", { type: "button", className: "btn btn-danger btn-small", textContent: "Remover" });
    remove.addEventListener("click", () => deleteFile(file));

    return el("li", { className: "file-card" },
      thumb,
      el("div", { className: "info" },
        el("span", { className: "fname", title: file.name, textContent: file.name }),
        el("span", { className: "muted", textContent: formatSize(file.size) }),
        remove,
      ),
    );
  });

  const placeholders = uploadingNames.map((name) =>
    el("li", { className: "file-card uploading" },
      el("div", { className: "thumb", textContent: "…" }),
      el("div", { className: "info" }, el("span", { className: "fname", textContent: name }), el("span", { className: "muted", textContent: "Enviando…" })),
    ),
  );

  fileList.replaceChildren(...cards, ...placeholders);
}

fileInput.addEventListener("change", () => {
  uploadFiles([...fileInput.files]);
  fileInput.value = "";
});

for (const type of ["dragenter", "dragover"]) {
  dropZone.addEventListener(type, (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
}
for (const type of ["dragleave", "drop"]) {
  dropZone.addEventListener(type, () => dropZone.classList.remove("dragover"));
}
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadFiles([...e.dataTransfer.files]);
});

// ---------- inicialização ----------

btnNew.addEventListener("click", newRecord);
btnDelete.addEventListener("click", deleteRecord);

async function checkApi() {
  try {
    await api("/health");
    apiStatus.textContent = "Conectado ao Azure";
    apiStatus.dataset.kind = "ok";
  } catch (err) {
    apiStatus.textContent = `API indisponível: ${err.message}`;
    apiStatus.dataset.kind = "error";
  }
}

async function loadUser() {
  try {
    const { clientPrincipal } = await (await fetch("/.auth/me")).json();
    if (clientPrincipal) $("#user-name").textContent = clientPrincipal.userDetails;
  } catch {}
}

loadUser();
checkApi();
newRecord();
refreshList();
setInterval(poll, POLL_MS);
