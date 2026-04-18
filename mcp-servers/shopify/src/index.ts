#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// --- Auth: Client Credentials flow (token expira em 24h) ---

interface TokenCache {
  accessToken: string;
  expiresAt: number; // timestamp ms
}

let tokenCache: TokenCache | null = null;

function getEnvConfig(): { storeUrl: string; clientId: string; clientSecret: string } {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!storeUrl || !clientId || !clientSecret) {
    throw new Error(
      'SHOPIFY_STORE_URL, SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET precisam estar configurados no Vault do LionClaw.',
    );
  }
  return { storeUrl, clientId, clientSecret };
}

async function getAccessToken(storeUrl: string, clientId: string, clientSecret: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.accessToken;
  }

  const url = `https://${storeUrl}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Credenciais invalidas (${res.status}). Verifique SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET no Vault.`,
      );
    }
    throw new Error(`Erro ao obter access token (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number; scope: string };
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return data.access_token;
}

// --- Shopify REST API ---

const API_VERSION = '2024-01';
const ANALYTICS_API_VERSION = '2025-10';

function baseUrl(storeUrl: string): string {
  return `https://${storeUrl}/admin/api/${API_VERSION}`;
}

async function shopifyFetch(
  endpoint: string,
  storeUrl: string,
  accessToken: string,
): Promise<{ data: unknown; linkHeader: string | null }> {
  const url = `${baseUrl(storeUrl)}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 401) {
    tokenCache = null;
    throw new Error(
      'Token expirado ou invalido (401). Tente novamente (o token sera renovado automaticamente).',
    );
  }
  if (res.status === 404) {
    throw new Error(`Recurso nao encontrado (404): ${endpoint}`);
  }
  if (res.status === 429) {
    throw new Error(
      'Limite de requisicoes atingido (429). Aguarde alguns segundos e tente novamente.',
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Erro Shopify (${res.status}): ${body}`);
  }

  const data = await res.json();
  const linkHeader = res.headers.get('link');
  return { data, linkHeader };
}

// --- Shopify GraphQL API ---

async function shopifyGraphQL(
  query: string,
  variables: Record<string, unknown>,
  storeUrl: string,
  accessToken: string,
  apiVersion: string = API_VERSION,
): Promise<unknown> {
  const url = `https://${storeUrl}/admin/api/${apiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    tokenCache = null;
    throw new Error('Token expirado ou invalido (401). Tente novamente.');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Erro GraphQL Shopify (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  return json.data;
}

function extractPageInfo(linkHeader: string | null, rel: string): string | null {
  if (!linkHeader) return null;
  const regex = new RegExp(`<[^>]*[?&]page_info=([^&>]+)[^>]*>;\\s*rel="${rel}"`);
  const match = linkHeader.match(regex);
  return match ? match[1] : null;
}

// --- Compact helpers (ultra-enxuto pra nao estourar contexto do LLM) ---

interface RawProduct {
  id: number;
  title: string;
  status: string;
  vendor: string;
  product_type: string;
  tags: string;
  variants: Array<{
    id: number;
    title: string;
    price: string;
    sku: string | null;
    inventory_quantity: number;
    inventory_item_id: number;
  }>;
  images: Array<{ src: string }>;
}

interface CompactProduct {
  id: number;
  title: string;
  status: string;
  vendor: string;
  product_type: string;
  tags: string;
  price_range: string;
  total_inventory: number;
  variants_count: number;
  image_src: string | null;
}

function compactProduct(p: RawProduct): CompactProduct {
  const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !isNaN(n));
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
  const priceRange = minPrice === maxPrice
    ? minPrice.toFixed(2)
    : `${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)}`;
  const totalInventory = (p.variants || []).reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);

  return {
    id: p.id,
    title: p.title,
    status: p.status,
    vendor: p.vendor,
    product_type: p.product_type,
    tags: p.tags,
    price_range: priceRange,
    total_inventory: totalInventory,
    variants_count: p.variants?.length ?? 0,
    image_src: p.images?.[0]?.src ?? null,
  };
}

interface RawOrder {
  id: number;
  name: string;
  created_at: string;
  total_price: string;
  financial_status: string;
  fulfillment_status: string | null;
  customer: { first_name: string; last_name: string; email: string } | null;
  line_items: Array<{
    title: string;
    quantity: number;
    price: string;
    sku: string | null;
    variant_title: string | null;
  }>;
}

interface CompactOrder {
  id: number;
  name: string;
  created_at: string;
  total_price: string;
  financial_status: string;
  fulfillment_status: string | null;
  customer_name: string | null;
  customer_email: string | null;
  line_items_summary: string;
  items_count: number;
}

function compactOrder(o: RawOrder): CompactOrder {
  const customerName = o.customer
    ? `${o.customer.first_name} ${o.customer.last_name}`.trim()
    : null;
  const summary = (o.line_items || [])
    .map(li => `${li.quantity}x ${li.title}${li.variant_title ? ` (${li.variant_title})` : ''}`)
    .join(', ');

  return {
    id: o.id,
    name: o.name,
    created_at: o.created_at,
    total_price: o.total_price,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    customer_name: customerName,
    customer_email: o.customer?.email ?? null,
    line_items_summary: summary,
    items_count: o.line_items?.length ?? 0,
  };
}

const COMPACT_PRODUCT_FIELDS = 'id,title,status,vendor,product_type,tags,variants,images';
const COMPACT_ORDER_FIELDS = 'id,name,created_at,total_price,financial_status,fulfillment_status,customer,line_items';

// --- MCP Server ---

const server = new Server(
  { name: 'shopify', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const fieldsSchema = {
  type: 'string' as const,
  description: 'Campos especificos a retornar (separados por virgula). Se nao informado, retorna campos resumidos.',
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_products',
      description:
        'Listar produtos da loja Shopify (resumo compacto). Use get_product para detalhes completos.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Quantidade de produtos (max 250, padrao 25).',
          },
          page_info: {
            type: 'string',
            description: 'Cursor de paginacao (retornado na chamada anterior).',
          },
          status: {
            type: 'string',
            enum: ['active', 'draft', 'archived'],
            description: 'Filtrar por status do produto.',
          },
          fields: fieldsSchema,
        },
      },
    },
    {
      name: 'get_product',
      description: 'Obter detalhes completos de um produto pelo ID.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          product_id: {
            type: 'string',
            description: 'ID do produto.',
          },
        },
        required: ['product_id'],
      },
    },
    {
      name: 'search_products',
      description:
        'Buscar produtos por texto livre (titulo, vendor, tag, tipo, SKU). Usa GraphQL para busca parcial.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Termo de busca (titulo, vendor, tag, tipo, SKU).',
          },
          limit: {
            type: 'number',
            description: 'Quantidade maxima de resultados (padrao 10, max 25).',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_inventory',
      description:
        'Obter niveis de estoque para um ou mais inventory item IDs.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          inventory_item_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de inventory_item_id para consultar.',
          },
        },
        required: ['inventory_item_ids'],
      },
    },
    {
      name: 'list_collections',
      description:
        'Listar colecoes (custom + smart) da loja Shopify.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Quantidade por tipo de colecao (padrao 50).',
          },
        },
      },
    },
    {
      name: 'get_collection_products',
      description: 'Listar produtos de uma colecao especifica (resumo compacto).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          collection_id: {
            type: 'string',
            description: 'ID da colecao.',
          },
          limit: {
            type: 'number',
            description: 'Quantidade de produtos (padrao 25).',
          },
          fields: fieldsSchema,
        },
        required: ['collection_id'],
      },
    },
    {
      name: 'list_orders',
      description: 'Listar pedidos da loja Shopify (resumo compacto). Use get_order para detalhes completos.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Quantidade de pedidos (padrao 25).',
          },
          status: {
            type: 'string',
            enum: ['open', 'closed', 'cancelled', 'any'],
            description: 'Filtrar por status (padrao: any).',
          },
          financial_status: {
            type: 'string',
            enum: [
              'authorized',
              'pending',
              'paid',
              'partially_paid',
              'refunded',
              'voided',
              'partially_refunded',
              'any',
              'unpaid',
            ],
            description: 'Filtrar por status financeiro.',
          },
          created_at_min: {
            type: 'string',
            description:
              'Data minima de criacao (ISO 8601, ex: 2024-01-01T00:00:00Z).',
          },
          fields: fieldsSchema,
        },
      },
    },
    {
      name: 'get_order',
      description: 'Obter detalhes completos de um pedido pelo ID.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          order_id: {
            type: 'string',
            description: 'ID do pedido.',
          },
        },
        required: ['order_id'],
      },
    },
    {
      name: 'analytics_query',
      description: 'Executar consulta ShopifyQL para relatorios e analytics da loja. O unico dataset disponivel e "sales". Exemplos validos: "FROM sales SHOW total_sales GROUP BY month SINCE -1y", "FROM sales SHOW net_sales, orders GROUP BY day SINCE -30d", "FROM sales SHOW average_order_value GROUP BY month SINCE -6m", "FROM sales SHOW total_sales GROUP BY product_title SINCE -3m ORDER BY total_sales DESC LIMIT 10".',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Query em ShopifyQL. Sintaxe: FROM sales SHOW {metricas} [GROUP BY {dimensao}] [SINCE {periodo}] [ORDER BY {campo} ASC|DESC] [LIMIT {n}]. IMPORTANTE: o unico dataset valido e "sales". Metricas validas: total_sales, net_sales, orders, average_order_value, gross_sales, discounts, returns, shipping, tax. Dimensoes para GROUP BY: day, week, month, quarter, year, product_title, product_type, product_vendor, billing_country, billing_city, billing_region, channel. Periodos: -7d, -30d, -90d, -3m, -6m, -1y, -2y.',
          },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    const { storeUrl, clientId, clientSecret } = getEnvConfig();
    const accessToken = await getAccessToken(storeUrl, clientId, clientSecret);

    switch (name) {
      case 'list_products': {
        const limit = Math.min((a.limit as number) || 25, 250);
        const pageInfo = a.page_info as string | undefined;
        const status = a.status as string | undefined;
        const customFields = a.fields as string | undefined;
        const useCompact = !customFields;

        let endpoint: string;
        if (pageInfo) {
          const params = new URLSearchParams({
            page_info: pageInfo,
            limit: String(limit),
          });
          if (useCompact) params.set('fields', COMPACT_PRODUCT_FIELDS);
          else params.set('fields', customFields);
          endpoint = `/products.json?${params}`;
        } else {
          const params = new URLSearchParams({ limit: String(limit) });
          if (status) params.set('status', status);
          if (useCompact) params.set('fields', COMPACT_PRODUCT_FIELDS);
          else params.set('fields', customFields);
          endpoint = `/products.json?${params}`;
        }

        const { data, linkHeader } = await shopifyFetch(endpoint, storeUrl, accessToken);
        const products = (data as { products: RawProduct[] }).products;
        const nextPage = extractPageInfo(linkHeader, 'next');

        const result: Record<string, unknown> = {
          total_retornado: products.length,
          produtos: useCompact ? products.map(compactProduct) : products,
        };
        if (nextPage) {
          result.proxima_pagina = nextPage;
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_product': {
        const productId = a.product_id as string;
        const { data } = await shopifyFetch(
          `/products/${encodeURIComponent(productId)}.json`,
          storeUrl,
          accessToken,
        );
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify((data as { product: unknown }).product, null, 2) },
          ],
        };
      }

      case 'search_products': {
        const query = a.query as string;
        const limit = Math.min((a.limit as number) || 10, 25);

        const gql = `
          query searchProducts($query: String!, $first: Int!) {
            products(first: $first, query: $query) {
              edges {
                node {
                  id
                  title
                  status
                  vendor
                  productType
                  tags
                  totalInventory
                  priceRangeV2 {
                    minVariantPrice { amount currencyCode }
                    maxVariantPrice { amount currencyCode }
                  }
                  totalVariants
                  featuredImage { url }
                }
              }
            }
          }
        `;

        const data = await shopifyGraphQL(gql, { query, first: limit }, storeUrl, accessToken) as {
          products: {
            edges: Array<{
              node: {
                id: string;
                title: string;
                status: string;
                vendor: string;
                productType: string;
                tags: string[];
                totalInventory: number;
                priceRangeV2: {
                  minVariantPrice: { amount: string; currencyCode: string };
                  maxVariantPrice: { amount: string; currencyCode: string };
                };
                totalVariants: number;
                featuredImage: { url: string } | null;
              };
            }>;
          };
        };

        const produtos = data.products.edges.map(({ node }) => {
          const numericId = node.id.split('/').pop();
          const min = parseFloat(node.priceRangeV2.minVariantPrice.amount);
          const max = parseFloat(node.priceRangeV2.maxVariantPrice.amount);

          return {
            id: numericId,
            title: node.title,
            status: node.status.toLowerCase(),
            vendor: node.vendor,
            product_type: node.productType,
            tags: node.tags.join(', '),
            price_range: min === max ? min.toFixed(2) : `${min.toFixed(2)} - ${max.toFixed(2)}`,
            currency: node.priceRangeV2.minVariantPrice.currencyCode,
            total_inventory: node.totalInventory,
            variants_count: node.totalVariants,
            image_src: node.featuredImage?.url ?? null,
          };
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ total_retornado: produtos.length, produtos }, null, 2),
          }],
        };
      }

      case 'get_inventory': {
        const ids = a.inventory_item_ids as string[];
        const { data } = await shopifyFetch(
          `/inventory_levels.json?inventory_item_ids=${ids.join(',')}`,
          storeUrl,
          accessToken,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                (data as { inventory_levels: unknown[] }).inventory_levels,
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'list_collections': {
        const limit = Math.min((a.limit as number) || 50, 250);

        const [customRes, smartRes] = await Promise.all([
          shopifyFetch(
            `/custom_collections.json?limit=${limit}`,
            storeUrl,
            accessToken,
          ),
          shopifyFetch(
            `/smart_collections.json?limit=${limit}`,
            storeUrl,
            accessToken,
          ),
        ]);

        const custom = (customRes.data as { custom_collections: unknown[] })
          .custom_collections;
        const smart = (smartRes.data as { smart_collections: unknown[] })
          .smart_collections;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  custom_collections: custom,
                  smart_collections: smart,
                  total: custom.length + smart.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'get_collection_products': {
        const collectionId = a.collection_id as string;
        const limit = Math.min((a.limit as number) || 25, 250);
        const customFields = a.fields as string | undefined;
        const useCompact = !customFields;

        const params = new URLSearchParams({ limit: String(limit) });
        if (useCompact) params.set('fields', COMPACT_PRODUCT_FIELDS);
        else params.set('fields', customFields);

        const { data } = await shopifyFetch(
          `/collections/${encodeURIComponent(collectionId)}/products.json?${params}`,
          storeUrl,
          accessToken,
        );
        const products = (data as { products: RawProduct[] }).products;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  total_retornado: products.length,
                  produtos: useCompact ? products.map(compactProduct) : products,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'list_orders': {
        const limit = Math.min((a.limit as number) || 25, 250);
        const status = (a.status as string) || 'any';
        const financialStatus = a.financial_status as string | undefined;
        const createdAtMin = a.created_at_min as string | undefined;
        const customFields = a.fields as string | undefined;
        const useCompact = !customFields;

        const params = new URLSearchParams({
          limit: String(limit),
          status,
        });
        if (financialStatus) params.set('financial_status', financialStatus);
        if (createdAtMin) params.set('created_at_min', createdAtMin);
        if (useCompact) params.set('fields', COMPACT_ORDER_FIELDS);
        else params.set('fields', customFields);

        const { data } = await shopifyFetch(
          `/orders.json?${params}`,
          storeUrl,
          accessToken,
        );
        const orders = (data as { orders: RawOrder[] }).orders;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  total_retornado: orders.length,
                  pedidos: useCompact ? orders.map(compactOrder) : orders,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'get_order': {
        const orderId = a.order_id as string;
        const { data } = await shopifyFetch(
          `/orders/${encodeURIComponent(orderId)}.json`,
          storeUrl,
          accessToken,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                (data as { order: unknown }).order,
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'analytics_query': {
        const shopifyqlQuery = a.query as string;

        const gql = `
          query analyticsQuery($query: String!) {
            shopifyqlQuery(query: $query) {
              __typename
              tableData {
                columns {
                  name
                  dataType
                  displayName
                }
                rows
              }
              parseErrors
            }
          }
        `;

        const data = await shopifyGraphQL(gql, { query: shopifyqlQuery }, storeUrl, accessToken, ANALYTICS_API_VERSION) as {
          shopifyqlQuery: {
            __typename: string;
            tableData?: {
              columns: Array<{ name: string; dataType: string; displayName: string }>;
              rows: Record<string, string>[];
            };
            parseErrors?: string;
          };
        };

        const result = data.shopifyqlQuery;

        // parseErrors pode ser string JSON, string vazia, "null", "[]", etc.
        const parsedErrors = result.parseErrors && result.parseErrors !== 'null' && result.parseErrors !== '[]'
          ? (() => { try { return JSON.parse(result.parseErrors!); } catch { return result.parseErrors; } })()
          : null;
        if (parsedErrors && (Array.isArray(parsedErrors) ? parsedErrors.length > 0 : true)) {
          return {
            content: [{
              type: 'text' as const,
              text: `Erro na query ShopifyQL: ${JSON.stringify(parsedErrors)}\n\nDica: Use "FROM sales SHOW total_sales GROUP BY month SINCE -1y" como referencia.`,
            }],
            isError: true,
          };
        }

        if (result.tableData) {
          const { columns, rows: rawRows } = result.tableData;
          const headers = columns.map(c => c.displayName || c.name);

          // rows são objetos com chaves nomeadas: { month: "2026-01-01", total_sales: "123" }
          let rows: Record<string, string>[] = [];
          if (Array.isArray(rawRows) && rawRows.length > 0) {
            rows = rawRows.map(row => {
              const obj: Record<string, string> = {};
              columns.forEach(col => { obj[col.displayName || col.name] = row[col.name]; });
              return obj;
            });
          }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                tipo: 'tabela',
                colunas: headers,
                total_linhas: rows.length,
                dados: rows,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      default:
        return {
          content: [{ type: 'text' as const, text: `Tool desconhecida: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        { type: 'text' as const, text: `Erro Shopify: ${(err as Error).message}` },
      ],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
