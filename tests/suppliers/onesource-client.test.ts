import { describe, it, expect } from 'vitest';
import {
  createOneSourceClient,
  parseProductFromXml,
  parseMediaContentFromXml,
} from '../../src/lib/onesource-client.js';
import * as cheerio from 'cheerio';

describe('createOneSourceClient', () => {
  it('throws when credentials are missing', () => {
    expect(() => createOneSourceClient({
      keyId: '',
      keyPassword: 'pass',
      supplierCode: 'TEST',
    })).toThrow('OneSource credentials are required');
  });

  it('throws when password is missing', () => {
    expect(() => createOneSourceClient({
      keyId: 'id',
      keyPassword: '',
      supplierCode: 'TEST',
    })).toThrow('OneSource credentials are required');
  });

  it('throws when supplier code is missing', () => {
    expect(() => createOneSourceClient({
      keyId: 'id',
      keyPassword: 'pass',
      supplierCode: '',
    })).toThrow('Supplier code is required');
  });

  it('creates client successfully with valid config', () => {
    const client = createOneSourceClient({
      keyId: 'testId',
      keyPassword: 'testPass',
      supplierCode: 'TESTSUPPLIER',
    });

    expect(client.getProduct).toBeDefined();
    expect(client.getProductDateModified).toBeDefined();
    expect(client.getMediaContent).toBeDefined();
  });
});

describe('parseProductFromXml', () => {
  it('parses a complete product response', () => {
    const xml = `
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <GetProductResponse xmlns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/">
            <Product>
              <productId>TEST123</productId>
              <productName>Test Product</productName>
              <description>A great test product with 60% cotton, 40% polyester.</description>
              <productBrand>TestBrand</productBrand>
              <primaryImageUrl>https://example.com/test.jpg</primaryImageUrl>
              <ProductCategoryArray>
                <ProductCategory>
                  <category>Apparel</category>
                  <subCategory>T-Shirts</subCategory>
                </ProductCategory>
              </ProductCategoryArray>
              <ProductMarketingPointArray>
                <ProductMarketingPoint>
                  <pointType>Highlights</pointType>
                  <pointCopy>Premium quality fabric</pointCopy>
                </ProductMarketingPoint>
              </ProductMarketingPointArray>
              <ProductKeywordArray>
                <ProductKeyword>
                  <keyword>t-shirt</keyword>
                </ProductKeyword>
              </ProductKeywordArray>
              <ProductPartArray>
                <ProductPart>
                  <partId>TEST123-BLK-S</partId>
                  <description>Black Small</description>
                  <primaryMaterial>60% cotton, 40% polyester</primaryMaterial>
                  <ColorArray>
                    <Color>
                      <colorName>Black</colorName>
                      <hex>#000000</hex>
                    </Color>
                  </ColorArray>
                  <ApparelSize>
                    <apparelStyle>Unisex</apparelStyle>
                    <labelSize>S</labelSize>
                  </ApparelSize>
                  <SpecificationArray>
                    <Specification>
                      <specificationType>Chest</specificationType>
                      <SpecificationUom>IN</SpecificationUom>
                      <measurementValue>18</measurementValue>
                    </Specification>
                  </SpecificationArray>
                  <isRushService>false</isRushService>
                </ProductPart>
              </ProductPartArray>
              <lastChangeDate>2025-01-01T00:00:00</lastChangeDate>
              <creationDate>2024-01-01T00:00:00</creationDate>
            </Product>
          </GetProductResponse>
        </soap:Body>
      </soap:Envelope>`;

    const $ = cheerio.load(xml, { xmlMode: true });
    const parsed = parseProductFromXml($);

    expect(parsed.productId).toBe('TEST123');
    expect(parsed.productName).toBe('Test Product');
    expect(parsed.description).toContain('great test product');
    expect(parsed.productBrand).toBe('TestBrand');
    expect(parsed.primaryImageUrl).toBe('https://example.com/test.jpg');
    expect(parsed.categories).toHaveLength(1);
    expect(parsed.categories[0].category).toBe('Apparel');
    expect(parsed.categories[0].subCategory).toBe('T-Shirts');
    expect(parsed.marketingPoints).toHaveLength(1);
    expect(parsed.keywords).toEqual(['t-shirt']);
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0].partId).toBe('TEST123-BLK-S');
    expect(parsed.parts[0].primaryMaterial).toBe('60% cotton, 40% polyester');
    expect(parsed.parts[0].colors[0].colorName).toBe('Black');
    expect(parsed.parts[0].apparelSize?.labelSize).toBe('S');
    expect(parsed.parts[0].specifications).toHaveLength(1);
    expect(parsed.parts[0].specifications[0].specificationType).toBe('Chest');
  });

  it('handles empty product response', () => {
    const xml = `
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <GetProductResponse>
            <Product>
              <productId></productId>
              <productName></productName>
            </Product>
          </GetProductResponse>
        </soap:Body>
      </soap:Envelope>`;

    const $ = cheerio.load(xml, { xmlMode: true });
    const parsed = parseProductFromXml($);

    expect(parsed.productId).toBe('');
    expect(parsed.parts).toHaveLength(0);
    expect(parsed.categories).toHaveLength(0);
  });
});

describe('parseMediaContentFromXml', () => {
  it('parses media content response', () => {
    const xml = `
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <GetMediaContentResponse>
            <MediaContentArray>
              <MediaContent>
                <productId>TEST123</productId>
                <partId>TEST123-BLK</partId>
                <url>https://example.com/images/test-black.jpg</url>
                <mediaType>Image</mediaType>
                <ClassTypeArray>
                  <ClassType>
                    <classTypeId>1006</classTypeId>
                    <classTypeName>Front</classTypeName>
                  </ClassType>
                </ClassTypeArray>
                <color>Black</color>
                <singlePart>true</singlePart>
              </MediaContent>
              <MediaContent>
                <productId>TEST123</productId>
                <url>https://example.com/images/test-blank.jpg</url>
                <mediaType>Image</mediaType>
                <ClassTypeArray>
                  <ClassType>
                    <classTypeId>1007</classTypeId>
                    <classTypeName>Back</classTypeName>
                  </ClassType>
                </ClassTypeArray>
                <singlePart>false</singlePart>
              </MediaContent>
            </MediaContentArray>
          </GetMediaContentResponse>
        </soap:Body>
      </soap:Envelope>`;

    const $ = cheerio.load(xml, { xmlMode: true });
    const media = parseMediaContentFromXml($);

    expect(media).toHaveLength(2);
    expect(media[0].productId).toBe('TEST123');
    expect(media[0].partId).toBe('TEST123-BLK');
    expect(media[0].url).toBe('https://example.com/images/test-black.jpg');
    expect(media[0].mediaType).toBe('Image');
    expect(media[0].color).toBe('Black');
    expect(media[0].classTypes[0].name).toBe('Front');
    expect(media[1].color).toBeUndefined();
  });

  it('handles empty media response', () => {
    const xml = `
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <GetMediaContentResponse/>
        </soap:Body>
      </soap:Envelope>`;

    const $ = cheerio.load(xml, { xmlMode: true });
    const media = parseMediaContentFromXml($);

    expect(media).toHaveLength(0);
  });
});
