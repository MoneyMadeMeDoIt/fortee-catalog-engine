import * as cheerio from 'cheerio';
import { logger } from './logger.js';

export interface OneSourceConfig {
  keyId: string;
  keyPassword: string;
  supplierCode: string;
}

export interface ServiceMessageError {
  code: number;
  description: string;
  severity: string;
}

const ONESOURCE_BASE = 'https://api.dc-onesource.com/xml';

function buildSoapEnvelope(namespace: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:ns="${namespace}"
  xmlns:shar="${namespace}SharedObjects/">
  <soap:Body>
    ${body}
  </soap:Body>
</soap:Envelope>`;
}

function extractText($: cheerio.CheerioAPI, el: cheerio.Element, tag: string): string {
  const found = $(el).find(tag).first();
  return found.length ? found.text().trim() : '';
}

function extractBool($: cheerio.CheerioAPI, el: cheerio.Element, tag: string): boolean {
  const text = extractText($, el, tag);
  return text === 'true';
}

export function createOneSourceClient(config: OneSourceConfig) {
  const { keyId, keyPassword, supplierCode } = config;

  if (!keyId || !keyPassword) {
    throw new Error(
      'OneSource credentials are required. Set ONESOURCE_KEY_ID and ONESOURCE_KEY_PASSWORD environment variables.'
    );
  }

  if (!supplierCode) {
    throw new Error('Supplier code is required.');
  }

  async function soapRequest(
    serviceCode: string,
    wsVersion: string,
    soapAction: string,
    bodyXml: string,
    namespace: string
  ): Promise<cheerio.CheerioAPI> {
    const url = `${ONESOURCE_BASE}/${supplierCode}/${serviceCode}/${wsVersion}/soap`;
    const envelope = buildSoapEnvelope(namespace, bodyXml);

    logger.info(`OneSource SOAP: ${soapAction} → ${supplierCode}/${serviceCode}/${wsVersion}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: soapAction,
      },
      body: envelope,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OneSource SOAP error (${response.status}): ${text.substring(0, 500)}`
      );
    }

    const xml = await response.text();
    const $ = cheerio.load(xml, { xmlMode: true });

    // Check for errors in response
    const errorMessages: ServiceMessageError[] = [];
    $('ServiceMessage, ErrorMessage').each((_, el) => {
      const severity = extractText($, el, 'severity');
      if (severity === 'Error') {
        errorMessages.push({
          code: parseInt(extractText($, el, 'code'), 10),
          description: extractText($, el, 'description'),
          severity,
        });
      }
    });

    if (errorMessages.length > 0) {
      const msg = errorMessages.map((e) => `[${e.code}] ${e.description}`).join('; ');
      throw new Error(`OneSource API error: ${msg}`);
    }

    return $;
  }

  // --- Product Data Service ---

  async function getProductDateModified(
    productServiceVersion: string,
    changeTimeStamp: string
  ): Promise<string[]> {
    const ns = `http://www.promostandards.org/WSDL/ProductDataService/${productServiceVersion}/`;
    const body = `<ns:GetProductDateModifiedRequest>
      <shar:wsVersion>${productServiceVersion}</shar:wsVersion>
      <shar:id>${keyId}</shar:id>
      <shar:password>${keyPassword}</shar:password>
      <shar:changeTimeStamp>${changeTimeStamp}</shar:changeTimeStamp>
    </ns:GetProductDateModifiedRequest>`;

    const $ = await soapRequest('Product', productServiceVersion, 'getProductDateModified', body, ns);

    const productIds: string[] = [];
    $('ProductDateModified').each((_, el) => {
      const productId = extractText($, el, 'productId');
      if (productId && !productIds.includes(productId)) {
        productIds.push(productId);
      }
    });

    return productIds;
  }

  async function getProduct(
    productServiceVersion: string,
    productId: string,
    localizationCountry = 'CA',
    localizationLanguage = 'en'
  ): Promise<cheerio.CheerioAPI> {
    const ns = `http://www.promostandards.org/WSDL/ProductDataService/${productServiceVersion}/`;
    const body = `<ns:GetProductRequest>
      <shar:wsVersion>${productServiceVersion}</shar:wsVersion>
      <shar:id>${keyId}</shar:id>
      <shar:password>${keyPassword}</shar:password>
      <shar:localizationCountry>${localizationCountry}</shar:localizationCountry>
      <shar:localizationLanguage>${localizationLanguage}</shar:localizationLanguage>
      <shar:productId>${productId}</shar:productId>
    </ns:GetProductRequest>`;

    return soapRequest('Product', productServiceVersion, 'getProduct', body, ns);
  }

  // --- Media Content Service ---

  async function getMediaContent(
    productId: string,
    mediaServiceVersion = '1.1.0'
  ): Promise<cheerio.CheerioAPI> {
    const ns = `http://www.promostandards.org/WSDL/MediaService/1.0.0/`;
    const body = `<ns:GetMediaContentRequest>
      <shar:wsVersion>${mediaServiceVersion}</shar:wsVersion>
      <shar:id>${keyId}</shar:id>
      <shar:password>${keyPassword}</shar:password>
      <shar:mediaType>Image</shar:mediaType>
      <shar:productId>${productId}</shar:productId>
    </ns:GetMediaContentRequest>`;

    return soapRequest('MED', mediaServiceVersion, 'getMediaContent', body, ns);
  }

  return {
    getProductDateModified,
    getProduct,
    getMediaContent,
    soapRequest,
  };
}

// --- Shared XML parsing helpers ---

export function parseProductFromXml($: cheerio.CheerioAPI): {
  productId: string;
  productName: string;
  description: string;
  productBrand: string;
  primaryImageUrl: string;
  categories: Array<{ category: string; subCategory?: string }>;
  parts: Array<{
    partId: string;
    description: string;
    primaryMaterial: string;
    colors: Array<{ colorName: string; hex?: string }>;
    apparelSize?: { apparelStyle: string; labelSize: string; customSize?: string };
    specifications: Array<{ specificationType: string; uom: string; value: string }>;
  }>;
  marketingPoints: Array<{ pointType?: string; pointCopy: string }>;
  keywords: string[];
  rawXml: string;
} {
  const product = $('Product').first();

  const productId = extractText($, product[0]!, 'productId');
  const productName = extractText($, product[0]!, 'productName');
  const primaryImageUrl = extractText($, product[0]!, 'primaryImageUrl');
  const productBrand = extractText($, product[0]!, 'productBrand');

  // Description - can be multiple
  const descriptions: string[] = [];
  product.children('description').each((_, el) => {
    descriptions.push($(el).text().trim());
  });
  const description = descriptions.join(' ');

  // Categories
  const categories: Array<{ category: string; subCategory?: string }> = [];
  product.find('ProductCategory').each((_, el) => {
    const cat = extractText($, el, 'category');
    const sub = extractText($, el, 'subCategory') || undefined;
    if (cat) categories.push({ category: cat, subCategory: sub });
  });

  // Marketing points
  const marketingPoints: Array<{ pointType?: string; pointCopy: string }> = [];
  product.find('ProductMarketingPoint').each((_, el) => {
    const pointType = extractText($, el, 'pointType') || undefined;
    const pointCopy = extractText($, el, 'pointCopy');
    if (pointCopy) marketingPoints.push({ pointType, pointCopy });
  });

  // Keywords
  const keywords: string[] = [];
  product.find('ProductKeyword').each((_, el) => {
    const kw = extractText($, el, 'keyword');
    if (kw) keywords.push(kw);
  });

  // Parts
  const parts: Array<{
    partId: string;
    description: string;
    primaryMaterial: string;
    colors: Array<{ colorName: string; hex?: string }>;
    apparelSize?: { apparelStyle: string; labelSize: string; customSize?: string };
    specifications: Array<{ specificationType: string; uom: string; value: string }>;
  }> = [];

  product.find('ProductPart').each((_, el) => {
    const partId = extractText($, el, 'partId');

    // Part description
    const partDescs: string[] = [];
    $(el).children('description').each((_, d) => {
      partDescs.push($(d).text().trim());
    });

    const primaryMaterial = extractText($, el, 'primaryMaterial');

    // Colors
    const colors: Array<{ colorName: string; hex?: string }> = [];
    $(el).find('Color').each((_, c) => {
      const colorName = extractText($, c, 'colorName');
      const hex = extractText($, c, 'hex') || undefined;
      if (colorName) colors.push({ colorName, hex });
    });

    // Apparel size
    const apparelSizeEl = $(el).find('ApparelSize').first();
    let apparelSize: { apparelStyle: string; labelSize: string; customSize?: string } | undefined;
    if (apparelSizeEl.length) {
      apparelSize = {
        apparelStyle: extractText($, apparelSizeEl[0]!, 'apparelStyle'),
        labelSize: extractText($, apparelSizeEl[0]!, 'labelSize'),
        customSize: extractText($, apparelSizeEl[0]!, 'customSize') || undefined,
      };
    }

    // Specifications
    const specifications: Array<{ specificationType: string; uom: string; value: string }> = [];
    $(el).find('Specification').each((_, s) => {
      specifications.push({
        specificationType: extractText($, s, 'specificationType'),
        uom: extractText($, s, 'SpecificationUom'),
        value: extractText($, s, 'measurementValue'),
      });
    });

    parts.push({
      partId,
      description: partDescs.join(' '),
      primaryMaterial,
      colors,
      apparelSize,
      specifications,
    });
  });

  return {
    productId,
    productName,
    description,
    productBrand,
    primaryImageUrl,
    categories,
    parts,
    marketingPoints,
    keywords,
    rawXml: $.xml(),
  };
}

export function parseMediaContentFromXml($: cheerio.CheerioAPI): Array<{
  productId: string;
  partId?: string;
  url: string;
  mediaType: string;
  classTypes: Array<{ id: number; name: string }>;
  color?: string;
  description?: string;
}> {
  const media: Array<{
    productId: string;
    partId?: string;
    url: string;
    mediaType: string;
    classTypes: Array<{ id: number; name: string }>;
    color?: string;
    description?: string;
  }> = [];

  $('MediaContent').each((_, el) => {
    const productId = extractText($, el, 'productId');
    const partId = extractText($, el, 'partId') || undefined;
    const url = extractText($, el, 'url');
    const mediaType = extractText($, el, 'mediaType');
    const color = extractText($, el, 'color') || undefined;
    const description = extractText($, el, 'description') || undefined;

    const classTypes: Array<{ id: number; name: string }> = [];
    $(el).find('ClassType').each((_, ct) => {
      classTypes.push({
        id: parseInt(extractText($, ct, 'classTypeId'), 10),
        name: extractText($, ct, 'classTypeName'),
      });
    });

    if (url) {
      media.push({ productId, partId, url, mediaType, classTypes, color, description });
    }
  });

  return media;
}

export { extractText, extractBool };
