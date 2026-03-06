import { createAdminApiClient } from '@shopify/admin-api-client';

/**
 * Creates a Shopify Admin API client from environment variables.
 * Requires SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN.
 */
export function createShopifyClient() {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!storeDomain) {
    throw new Error(
      'Missing SHOPIFY_STORE_DOMAIN environment variable. ' +
      'Set it to your Shopify store domain (e.g., my-store.myshopify.com).'
    );
  }

  if (!accessToken) {
    throw new Error(
      'Missing SHOPIFY_ADMIN_ACCESS_TOKEN environment variable. ' +
      'Create an Admin API access token in your Shopify admin under Settings > Apps.'
    );
  }

  return createAdminApiClient({
    storeDomain,
    accessToken,
    apiVersion: '2025-01',
  });
}
