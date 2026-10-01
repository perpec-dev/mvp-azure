const { app } = require("@azure/functions");
const { randomUUID } = require("node:crypto");
const { getTable, getContainer, PARTITION } = require("../lib/storage");

const ROLE = "usuario";   // função atribuída por convite no portal (Gerenciamento de funções)
const ID_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ["nome", "email", "telefone", "categoria", "data", "descricao"];
const MAX_FIELD_LENGTH = 4000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

const json = (status, body) => ({ status, jsonBody: body });
const notFound = () => json(404, { error: "Registro não encontrado" });

// O Static Web Apps envia o usuário logado no header x-ms-client-principal (JSON em base64).
function getUser(request) {
  const header = request.headers.get("x-ms-client-principal");
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// Envolve cada handler: exige usuário com a função ROLE, valida ids da rota
// e transforma exceções em 500 com log.
function handler(fn) {
  return async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: "Faça login" });
    if (!user.userRoles?.includes(ROLE)) return json(403, { error: "Usuário sem permissão" });
    request.user = user;

    for (const key of ["id", "fileId"]) {
      const value = request.params[key];
      if (value !== undefined && !ID_RE.test(value)) return json(400, { error: `${key} inválido` });
    }
    try {
      return await fn(request, context);
    } catch (err) {
      context.error(err);
      return json(500, { error: "Erro interno no servidor" });
    }
  };
}

function toRecord(entity) {
  const record = {
    id: entity.rowKey,
    createdAt: entity.createdAt,
    createdBy: entity.createdBy ?? "",
    updatedAt: entity.updatedAt,
    updatedBy: entity.updatedBy ?? "",
  };
  for (const field of FIELDS) record[field] = entity[field] ?? "";
  return record;
}

async function findEntity(table, id) {
  try {
    return await table.getEntity(PARTITION, id);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

// Marca o registro como alterado (para outras abas perceberem mudanças nos anexos).
async function touch(id, user) {
  const table = await getTable();
  try {
    await table.updateEntity(
      { partitionKey: PARTITION, rowKey: id, updatedAt: new Date().toISOString(), updatedBy: user.userDetails },
      "Merge",
    );
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

async function listFiles(recordId) {
  const container = await getContainer();
  const files = [];
  for await (const blob of container.listBlobsFlat({ prefix: `${recordId}/`, includeMetadata: true })) {
    files.push({
      id: blob.name.slice(recordId.length + 1),
      name: decodeURIComponent(blob.metadata?.originalname ?? "arquivo"),
      type: blob.properties.contentType,
      size: blob.properties.contentLength,
      uploadedAt: blob.properties.createdOn,
    });
  }
  return files.sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
}

// Confere a assinatura binária do arquivo — não confia só no tipo informado pelo navegador.
function matchesSignature(buffer, type) {
  const ascii = (start, end) => buffer.subarray(start, end).toString("latin1");
  switch (type) {
    case "application/pdf": return ascii(0, 5) === "%PDF-";
    case "image/png": return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg": return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/gif": return ascii(0, 4) === "GIF8";
    case "image/webp": return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    default: return false;
  }
}

// ---------- rotas ----------

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async (request, context) => {
    try {
      await Promise.all([getTable(), getContainer()]);
      return json(200, { ok: true });
    } catch (err) {
      context.error(err);
      return json(503, { ok: false, error: err.message });
    }
  },
});

app.http("records-list", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "records",
  handler: handler(async () => {
    const table = await getTable();
    const records = [];
    for await (const entity of table.listEntities()) {
      records.push(toRecord(entity));
    }
    records.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return json(200, records.slice(0, 200));
  }),
});

app.http("records-item", {
  methods: ["GET", "PUT", "DELETE"],
  authLevel: "anonymous",
  route: "records/{id}",
  handler: handler(async (request) => {
    const { id } = request.params;
    const table = await getTable();

    if (request.method === "GET") {
      const entity = await findEntity(table, id);
      if (!entity) return notFound();
      return json(200, { ...toRecord(entity), files: await listFiles(id) });
    }

    if (request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return json(400, { error: "JSON inválido" }); }

      const existing = await findEntity(table, id);
      const now = new Date().toISOString();
      const entity = {
        partitionKey: PARTITION,
        rowKey: id,
        createdAt: existing?.createdAt ?? now,
        createdBy: existing?.createdBy ?? request.user.userDetails,
        updatedAt: now,
        updatedBy: request.user.userDetails,
      };
      for (const field of FIELDS) {
        entity[field] = String(body?.[field] ?? "").slice(0, MAX_FIELD_LENGTH);
      }
      await table.upsertEntity(entity, "Merge");
      return json(200, toRecord(entity));
    }

    // DELETE: remove os anexos e depois o registro
    const container = await getContainer();
    for await (const blob of container.listBlobsFlat({ prefix: `${id}/` })) {
      await container.deleteBlob(blob.name, { deleteSnapshots: "include" });
    }
    try {
      await table.deleteEntity(PARTITION, id);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
    return { status: 204 };
  }),
});

app.http("files-upload", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "records/{id}/files",
  handler: handler(async (request) => {
    const { id } = request.params;
    const table = await getTable();
    if (!(await findEntity(table, id))) return notFound();

    let file;
    try {
      file = (await request.formData()).get("file");
    } catch {
      return json(400, { error: "Envie o arquivo como multipart/form-data no campo 'file'" });
    }
    if (!file || typeof file === "string") return json(400, { error: "Campo 'file' ausente" });
    if (!ALLOWED_TYPES.includes(file.type)) return json(415, { error: "Apenas imagens (PNG, JPG, GIF, WEBP) e PDF" });
    if (file.size > MAX_FILE_BYTES) return json(413, { error: "Arquivo maior que 10 MB" });

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!matchesSignature(buffer, file.type)) return json(415, { error: "Conteúdo do arquivo não corresponde ao tipo" });

    const fileId = randomUUID();
    const name = (file.name || "arquivo").slice(0, 200);
    const container = await getContainer();
    await container.getBlockBlobClient(`${id}/${fileId}`).uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: file.type },
      metadata: { originalname: encodeURIComponent(name) },   // metadados aceitam só ASCII
    });
    await touch(id, request.user);

    return json(201, { id: fileId, name, type: file.type, size: buffer.length, uploadedAt: new Date().toISOString() });
  }),
});

app.http("files-item", {
  methods: ["GET", "DELETE"],
  authLevel: "anonymous",
  route: "records/{id}/files/{fileId}",
  handler: handler(async (request) => {
    const { id, fileId } = request.params;
    const container = await getContainer();
    const blob = container.getBlockBlobClient(`${id}/${fileId}`);

    if (request.method === "DELETE") {
      await blob.deleteIfExists({ deleteSnapshots: "include" });
      await touch(id, request.user);
      return { status: 204 };
    }

    if (!(await blob.exists())) return json(404, { error: "Arquivo não encontrado" });
    const props = await blob.getProperties();
    const name = decodeURIComponent(props.metadata?.originalname ?? "arquivo");
    return {
      status: 200,
      body: await blob.downloadToBuffer(),
      headers: {
        "Content-Type": props.contentType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "private, max-age=300",
      },
    };
  }),
});
