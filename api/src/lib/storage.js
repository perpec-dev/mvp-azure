// Acesso ao Azure Storage: Table Storage guarda os campos do formulário,
// Blob Storage guarda os anexos (um "diretório" por registro: <recordId>/<fileId>).

const { TableClient } = require("@azure/data-tables");
const { BlobServiceClient } = require("@azure/storage-blob");

const TABLE_NAME = "registros";
const CONTAINER_NAME = "anexos";
const PARTITION = "form";

let tablePromise = null;
let containerPromise = null;

function connectionString() {
  const value = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!value) throw new Error("AZURE_STORAGE_CONNECTION_STRING não configurada");
  return value;
}

// Cria a tabela/container na primeira chamada e reaproveita o cliente nas seguintes.
function getTable() {
  tablePromise ??= (async () => {
    const client = TableClient.fromConnectionString(connectionString(), TABLE_NAME);
    try {
      await client.createTable();
    } catch (err) {
      if (err.statusCode !== 409) throw err;   // 409 = já existe
    }
    return client;
  })().catch((err) => { tablePromise = null; throw err; });
  return tablePromise;
}

function getContainer() {
  containerPromise ??= (async () => {
    const client = BlobServiceClient.fromConnectionString(connectionString()).getContainerClient(CONTAINER_NAME);
    await client.createIfNotExists();   // container privado: acesso só pela API
    return client;
  })().catch((err) => { containerPromise = null; throw err; });
  return containerPromise;
}

module.exports = { getTable, getContainer, PARTITION };
