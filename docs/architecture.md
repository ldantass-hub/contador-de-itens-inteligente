# Arquitetura do Contador de Itens Inteligente

## Visão geral

Monorepo pnpm com TypeScript para contagem de inventário por código de barras, autenticação, sessões de inventário e painel de supervisão.

## Stack

- Monorepo: pnpm workspaces
- Runtime: Node.js
- Frontend: React 19, Vite e Tailwind CSS em `artifacts/barcode-processor`
- Backend: Express 5 e TypeScript em `artifacts/api-server`
- Banco de dados: PostgreSQL via Drizzle ORM e `node-postgres`
- Autenticação: JWT em cookie HttpOnly e bcrypt para senhas
- Planilhas: ExcelJS
- Build: esbuild no backend e Vite no frontend

## Organização do projeto

### `artifacts/api-server`

API Express montada sob `/api`. O arquivo `src/lib/db.ts` concentra a persistência PostgreSQL, helpers de usuários, sessões, contagens, itens e limpeza de retenção. As rotas ficam em `src/routes/` e a autenticação em `src/middlewares/authenticate.ts`.

### `artifacts/barcode-processor`

Aplicação React principal. Contém login, seleção de organização, contador de códigos, importação/comparação/exportação de planilhas e painel de supervisão.

### `artifacts/mockup-sandbox`

Sandbox separado para pré-visualização de componentes e mockups.

### `lib/db`

Pacote compartilhado que exporta a conexão Drizzle/PostgreSQL e o schema das tabelas existentes.

## Rotas da API

### Saúde

- `GET /api/health` — health check da API.

### Autenticação

- `POST /api/auth/login` — autentica usuário e define o cookie de acesso.
- `GET /api/auth/me` — retorna o usuário autenticado.
- `POST /api/auth/logout` — limpa o cookie de acesso.
- `PUT /api/auth/password` — altera a senha do próprio usuário autenticado.

### Sessões

- `POST /api/sessions/resume` — retoma ou cria sessão.
- `POST /api/sessions/select-organization` — seleciona a organização da sessão.
- `GET /api/sessions/current` — retorna a sessão ativa.
- `PUT /api/sessions/ping` — atualiza a atividade da sessão.
- `POST /api/sessions/encerrar` — finaliza a sessão atual.
- `POST /api/sessions/salvar` — salva contagem sem finalizar.
- `POST /api/sessions/finalizar` — salva contagem e finaliza a sessão.

### Administração

As rotas administrativas exigem autenticação e role `admin`.

- `GET /api/admin/users` — lista usuários sem senhas.
- `POST /api/admin/users` — cria usuário ou administrador.
- `GET /api/admin/sessions` — lista sessões com filtros.
- `GET /api/admin/sessions/:id` — consulta detalhes e contagens.
- `GET /api/admin/sessions/:id/export` — exporta uma sessão para Excel.

### Estoque e planilhas

- `POST /api/estoque/finalizar` — endpoint legado de finalização.
- `GET /api/estoque/itens` — retorna itens da sessão ativa.
- `POST /api/estoque/upload` — importa uma planilha de referência.
- `GET /api/estoque/comparar?sessionId=` — compara contagens com a planilha.
- `GET /api/estoque/preview-exportar?sessionId=` — prepara a prévia de exportação.
- `GET /api/estoque/exportar?sessionId=` — exporta a sessão para Excel.

## Autenticação e autorização

O backend emite um JWT após o login e o envia no cookie `access_token`, configurado como HttpOnly, `Path=/`, `SameSite=Lax` e `Secure` em produção. O frontend envia cookies com `credentials: "include"` e valida a sessão inicial por `GET /api/auth/me`.

O middleware `authenticate` valida o cookie de acesso. Durante a transição de autenticação, o backend também mantém suporte temporário ao header Bearer para clientes legados. O frontend atual não armazena JWT no `localStorage` nem monta headers Bearer.

Rotas administrativas usam `requireAdmin` e verificam o role `admin` presente na identidade autenticada.

## Banco de dados

O schema PostgreSQL é definido em `lib/db/src/schema/index.ts`.

- `users` — identidade, username, hash bcrypt e role.
- `sessions` — usuário, organização, timestamps e status (`active` ou `finished`).
- `counts` — código e quantidade por sessão, com unicidade por sessão e código.
- `itens` — agregado legado de itens.

A inicialização da camada de persistência executa limpeza de sessões/contagens com mais de 180 dias e pode criar usuários de bootstrap somente quando as variáveis de ambiente correspondentes estiverem configuradas. Usuários existentes não são alterados pelo bootstrap.

## Fluxo de sessões

1. O usuário faz login.
2. O sistema verifica se existe sessão ativa.
3. Sessões recentes podem ser retomadas.
4. Uma organização é selecionada e associada à sessão.
5. Cada leitura pode atualizar `last_update` com `PUT /api/sessions/ping`.
6. A contagem pode ser salva sem finalizar a sessão.
7. A finalização salva a contagem e marca a sessão como `finished`.
8. Uma sessão ativa não pode ser trocada diretamente para outra organização.

## Parser de códigos

O parser fica em `artifacts/barcode-processor/src/lib/barcodeProcessor.ts`.

### Sanitização

Caracteres não alfanuméricos no início da entrada são removidos antes do processamento.

### Códigos de exceção

Os códigos abaixo são reconhecidos diretamente como códigos:

```text
624-087J  624-085D  624-087H  624-087B  624-087D  586-008B  6631R-G007H
```

### Formatos suportados

1. Código de exceção.
2. `CODE;QTY` ou `CODE;QTY;NOISE`.
3. `CODE.NOISE.QTY`.
4. Número isolado de quantidade, quando já existe código ativo.
5. Código alfanumérico de 11 caracteres.
6. Código concatenado com ruído e quantidade final.

### Modo de item único

O primeiro código válido fixa o item da operação. Outros códigos são rejeitados e registrados como entradas ignoradas.
