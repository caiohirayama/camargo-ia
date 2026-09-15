# Base RAG Camargo

Os arquivos em `knowledge/` guardam fatos e políticas da Camargo Atacarejo de Bebidas que podem mudar sem alterar o comportamento central do agente.

## Separação de responsabilidades

- `src/prompts/camargo_agent_prompt.md`: identidade, estilo, fluxo, segurança e formato de saída.
- `knowledge/company.md`: empresa, contato, endereço e retirada.
- `knowledge/hours.md`: horário de atendimento.
- `knowledge/commercial-policies.md`: preço/estoque, orçamento, fora do escopo e reclamações.

Preço, disponibilidade e unidade de venda de produtos **não** ficam no RAG — vêm sempre da consulta em tempo real ao catálogo (`consultar_produtos`, ver `src/services/productService.js`).

O serviço indexa arquivos `.md` e `.txt` automaticamente. Para revisar a recuperação, use `POST /test/rag/search` com `{ "query": "..." }`.
