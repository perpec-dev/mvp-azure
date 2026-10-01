# MVP Azure — formulário com anexos e salvamento automático

Aplicação mínima para aprender o fluxo completo no Azure: front-end estático, API serverless e dados persistidos na nuvem.

## Arquitetura

```
Navegador ──► Azure Static Web Apps (plano Free)
              ├─ /           → web/  (HTML, CSS, JS)
              └─ /api/*      → api/  (Azure Functions gerenciadas, Node 22)
                                  │
                                  ▼
                       Conta de Armazenamento (Storage Account)
                       ├─ Table Storage  "registros" → campos do formulário
                       └─ Blob Storage   "anexos"    → imagens e PDFs (privado)
```

- **Salvamento em tempo real:** cada alteração no formulário é gravada no Azure ~0,7 s depois que você para de digitar. Anexos sobem assim que são escolhidos/arrastados.
- **Sincronização:** a cada 10 s a página consulta a API; se o registro aberto foi alterado em outra aba/computador, ele é recarregado.
- **Login:** feito pelo próprio Static Web Apps com conta Microsoft (Entra ID). Qualquer conta Microsoft consegue *se autenticar*, mas só entra no app quem foi **convidado com a função `usuario`** (passo 7). Quem não tem convite vê a página "Sem permissão". A API confere o usuário de novo em toda chamada e grava quem criou e quem alterou cada registro.
- **Segurança básica:** o container de blobs é privado (arquivos só saem pela API, que exige login), a API valida tipo/tamanho e confere a assinatura binária do arquivo.

### Estrutura

```
web/index.html                 página principal (exige login + função "usuario")
web/login.html                 tela de entrada (pública)
web/sem-acesso.html            exibida para quem logou mas não foi convidado
web/styles.css                 estilos
web/app.js                     autosave, upload, lista, usuário logado
web/staticwebapp.config.json   runtime da API, regras de acesso e redirecionamento de login
api/src/functions/records.js   rotas da API
api/src/lib/storage.js         clientes do Table e Blob Storage
api/local.settings.example.json  modelo das variáveis para rodar localmente
swa-cli.config.json            configuração do emulador local (swa start)
```

### Rotas da API

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/health` | testa a conexão com o Storage |
| GET | `/api/records` | lista registros |
| GET / PUT / DELETE | `/api/records/{id}` | lê, grava (autosave) ou exclui um registro |
| POST | `/api/records/{id}/files` | envia anexo (`multipart/form-data`, campo `file`) |
| GET / DELETE | `/api/records/{id}/files/{fileId}` | baixa ou remove anexo |

---

## Passo a passo

### 0. Instalar as ferramentas (uma vez)

1. **Node.js 22 LTS**: baixe em <https://nodejs.org> (ou `winget install OpenJS.NodeJS.22`). Feche e reabra o terminal e confira com `node -v`.
2. **Liberar scripts no PowerShell** (só para o seu usuário, não precisa de administrador). Sem isso, `npm`, `swa` e `func` dão o erro *"a execução de scripts foi desabilitada neste sistema"*:
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```
   Se a política da empresa bloquear esse comando, use as versões `.cmd`: `npm.cmd`, `swa.cmd`, `func.cmd` (ou rode tudo no **Prompt de Comando**/cmd).
3. **CLIs do Azure** (no PowerShell):
   ```powershell
   npm install -g @azure/static-web-apps-cli azure-functions-core-tools@4
   ```
4. **Conta no GitHub** (o deploy é feito automaticamente a partir dele).
5. Opcional no VS Code: extensões *Azure Static Web Apps*, *Azure Functions* e *Azure Storage*.

### 1. Criar o Grupo de Recursos

Um grupo de recursos é uma "pasta" que agrupa tudo do projeto — no fim do teste, apagar o grupo apaga tudo.

1. No portal, pesquise **Grupos de recursos** → **Criar**.
2. Nome: `rg-mvp-azure` · Região: **Brazil South** → **Revisar + criar** → **Criar**.

### 2. Criar a Conta de Armazenamento

1. Pesquise **Contas de armazenamento** → **Criar**.
2. Aba *Básico*:
   - Grupo de recursos: `rg-mvp-azure`
   - Nome: algo único, só minúsculas e números, ex.: `stmvpazurejoao01`
   - Região: **Brazil South**
   - Desempenho: **Standard** · Redundância: **LRS** (a mais barata)
3. Deixe o resto no padrão → **Revisar + criar** → **Criar**.
4. Quando terminar: abra a conta → **Segurança + rede → Chaves de acesso** → em *key1*, clique **Mostrar** na **Cadeia de conexão** e copie.

> A tabela `registros` e o container `anexos` são criados automaticamente pela API na primeira chamada.

### 3. Rodar localmente, já gravando no Azure

1. Copie `api/local.settings.example.json` para `api/local.settings.json` e cole a cadeia de conexão em `AZURE_STORAGE_CONNECTION_STRING`. (Esse arquivo está no `.gitignore` — nunca suba para o GitHub.)
2. No terminal, na pasta do projeto:
   ```powershell
   cd api
   npm install
   cd ..
   swa start
   ```
3. Abra <http://localhost:4280>. Você cai na tela **Entrar**. Localmente o login é **simulado** pelo `swa start`: ao clicar em *Entrar com conta Microsoft* aparece um formulário de teste. Preencha:
   - **Username:** seu e-mail (qualquer texto serve)
   - **User's roles:** acrescente uma linha com `usuario` (sem isso você cai em "Sem permissão")
   - clique **Login**
4. O selo no topo deve mostrar **Conectado ao Azure** e seu e-mail aparece ao lado do botão **Sair**.
5. Preencha o formulário e anexe uma imagem e um PDF.
6. Confira no portal: conta de armazenamento → **Navegador de armazenamento** → *Tabelas → registros* e *Contêineres de blobs → anexos*. Os dados estão lá.

### 4. Subir o código para o GitHub

1. Crie um repositório **privado** vazio no GitHub, ex.: `mvp-azure`.
2. Na pasta do projeto:
   ```powershell
   git init
   git add .
   git commit -m "MVP Azure: formulário com anexos"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/mvp-azure.git
   git push -u origin main
   ```
   Antes do commit, rode `git status` e confirme que `api/local.settings.json` **não** aparece.

### 5. Criar o Static Web App

1. No portal, pesquise **Aplicativos Web Estáticos** → **Criar**.
2. Aba *Básico*:
   - Grupo de recursos: `rg-mvp-azure`
   - Nome: `swa-mvp-azure`
   - Plano: **Free**
   - Origem: **GitHub** → autorize e escolha organização, repositório `mvp-azure` e branch `main`
3. *Detalhes do build*:
   - Predefinições de build: **Personalizado**
   - Local do aplicativo: `web`
   - Local da API: `api`
   - Local de saída: *(deixe vazio)*
4. **Revisar + criar** → **Criar**.

O Azure cria um arquivo em `.github/workflows/` no seu repositório e dispara o primeiro deploy (aba **Actions** do GitHub, ~2–4 min). Rode `git pull` localmente para trazer esse arquivo.

### 6. Configurar a conexão com o Storage na nuvem

O `local.settings.json` só vale no seu PC. Na nuvem a variável é configurada no portal:

1. Abra o Static Web App → **Configurações → Variáveis de ambiente**.
2. Ambiente *Produção* → **Adicionar**:
   - Nome: `AZURE_STORAGE_CONNECTION_STRING`
   - Valor: a mesma cadeia de conexão do passo 2
3. **Aplicar** / **Salvar**.

### 7. Liberar o acesso (convites)

O app só abre para quem tem a função `usuario`. Comece convidando a si mesmo:

1. Abra o Static Web App → **Configurações → Gerenciamento de funções** → **Convidar**.
2. Preencha:
   - Provedor de autorização: **Microsoft Entra ID**
   - Detalhes do convidado: o e-mail da conta Microsoft da pessoa, ex.: `joao@perpec.com.br`
   - Domínio: o endereço `*.azurestaticapps.net` do app
   - Funções: `usuario`
   - Expiração do convite: `24` horas
3. **Gerar** → copie o **link do convite** e envie para a pessoa (ou abra você mesmo).
4. A pessoa abre o link, entra com a conta Microsoft e aceita o consentimento. Pronto: ela aparece na lista de usuários com a função `usuario`.

Para **tirar o acesso** de alguém: na mesma lista, clique no usuário e remova a função `usuario` (ou exclua). O plano Free permite até 25 usuários convidados.

### 8. Testar em produção

1. Na *Visão geral* do Static Web App, abra a **URL** (`https://<nome>.azurestaticapps.net`).
2. Você cai em **Entrar** → entre com a conta convidada.
3. Confirme o selo **Conectado ao Azure** e seu e-mail no topo; crie um registro, anexe arquivos. Na lista lateral aparece quem fez a última alteração.
4. Abra a URL numa janela anônima: sem login, a página redireciona para **Entrar**; com uma conta não convidada, aparece **Sem permissão**.

A partir daqui, todo `git push` na `main` faz um novo deploy automaticamente.

### 9. Controle de custos e limpeza

- O Static Web Apps **Free** é gratuito. Na conta de armazenamento, os 5 GB de Blob estão na conta gratuita de 12 meses; o Table Storage é cobrado por uso, mas para um teste fica em centavos.
- Crie um alerta: **Gerenciamento de Custos → Orçamentos → Adicionar**, ex.: R$ 20/mês com aviso por e-mail.
- Terminou de testar? Apague o grupo de recursos `rg-mvp-azure` e tudo some.

---

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Selo "API indisponível: AZURE_STORAGE_CONNECTION_STRING não configurada" | Variável não criada (passo 6) ou nome digitado errado. |
| Selo "API indisponível: 404" | `Local da API` diferente de `api` no workflow (`.github/workflows/*.yml`, campo `api_location`). |
| Erro 403 / "Key based authentication is not permitted" | Política da organização bloqueia acesso por chave na conta de armazenamento. Em *Configuração* da conta, veja "Permitir acesso à chave da conta de armazenamento". |
| `swa start` não sobe a API | Azure Functions Core Tools não instalado (`func --version`) ou faltou `npm install` em `api/`. |
| Deploy falha no GitHub Actions | Veja o log na aba **Actions**; normalmente é caminho errado de `app_location`/`api_location`. |
| Depois do login aparece "Sem permissão" | Conta sem a função `usuario`: gere o convite (passo 7) com o mesmo e-mail com que você entrou. Localmente, digite `usuario` em *User's roles* no login simulado. |
| Microsoft pede "aprovação do administrador" ao entrar | O tenant da Perpec bloqueia consentimento de usuários para apps externos. Peça à TI para aprovar o app *Azure Static Web Apps* ou, no plano Standard, registre um provedor Entra ID próprio. |
| Fica voltando para a tela Entrar | Cookies bloqueados para o domínio `*.azurestaticapps.net`, ou a sessão expirou — entre de novo. |

---

## Próximos passos (rumo ao projeto grande)

1. **Login só do tenant Perpec:** hoje qualquer conta Microsoft consegue se autenticar (o convite é que libera o acesso). No plano Standard dá para registrar um provedor Entra ID próprio, limitado ao tenant da Perpec, e atribuir funções automaticamente por grupo do Entra (sem convites manuais).
2. **Sem segredos no código/portal:** trocar a cadeia de conexão por **Identidade Gerenciada** + **Key Vault**. Isso exige uma Function App própria vinculada ao Static Web App ("bring your own functions", plano Standard).
3. **Uploads grandes:** em vez de passar o arquivo pela API, a API gera uma URL **SAS** temporária e o navegador envia direto para o Blob.
4. **Banco de dados:** para consultas e relacionamentos, **Azure Database for PostgreSQL – Servidor Flexível B1MS** (750 h/mês grátis por 12 meses) ou **Cosmos DB** (camada gratuita permanente).
5. **Tempo real de verdade:** trocar o polling de 10 s por **Azure Web PubSub** ou **SignalR Service** (ambos têm camada gratuita).
6. **Ambientes:** cada Pull Request no GitHub ganha um ambiente de pré-visualização automático no Static Web Apps.
7. **Infraestrutura como código:** descrever os recursos em **Bicep** e publicar com `azd up`, para recriar tudo com um comando.
8. **Monitoramento:** Application Insights para logs, erros e desempenho da API.
