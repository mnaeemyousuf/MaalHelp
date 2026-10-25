/**
 * Pakistan localisation pack. Kept modular: other markets add a sibling file
 * exporting the same `LocalizationPack` shape, and nothing in business logic
 * imports Pakistan specifics directly.
 */
export interface TaxPreset {
  code: string;
  name: string;
  rate: number;
  type: 'sales_tax' | 'gst' | 'vat' | 'withholding' | 'none';
  appliesTo: 'sales' | 'purchase' | 'both';
  isDefault?: boolean;
}

export interface LocalizationPack {
  country: string;
  countryCode: string;
  defaultCurrency: string;
  timezone: string;
  phonePattern: RegExp;
  phoneExample: string;
  taxIdentifiers: { key: string; label: string; pattern: RegExp; example: string }[];
  taxPresets: TaxPreset[];
  cities: string[];
  provinces: string[];
  banks: string[];
  paymentMethods: string[];
}

export const PAKISTAN: LocalizationPack = {
  country: 'Pakistan',
  countryCode: 'PK',
  defaultCurrency: 'PKR',
  timezone: 'Asia/Karachi',
  // +92 3XX XXXXXXX mobile or 0XX landline formats
  phonePattern: /^(\+92|0092|0)?\s?-?(3\d{2}|[1-9]\d{1,2})\s?-?\d{7}$/,
  phoneExample: '+92 300 1234567',
  taxIdentifiers: [
    { key: 'ntn', label: 'NTN', pattern: /^\d{7}-?\d$/, example: '1234567-8' },
    { key: 'strn', label: 'STRN', pattern: /^\d{2}-?\d{2}-?\d{4}-?\d{3}-?\d{2}$|^\d{13}$/, example: '32-77-8761-234-56' },
  ],
  taxPresets: [
    { code: 'GST18', name: 'Sales Tax 18%', rate: 18, type: 'sales_tax', appliesTo: 'both', isDefault: true },
    { code: 'GST0', name: 'Zero-rated', rate: 0, type: 'sales_tax', appliesTo: 'both' },
    { code: 'EXEMPT', name: 'Exempt', rate: 0, type: 'none', appliesTo: 'both' },
    { code: 'PST16', name: 'Punjab Services Tax 16%', rate: 16, type: 'sales_tax', appliesTo: 'sales' },
    { code: 'SST15', name: 'Sindh Services Tax 15%', rate: 15, type: 'sales_tax', appliesTo: 'sales' },
    { code: 'WHT4.5', name: 'Withholding 4.5% (goods)', rate: 4.5, type: 'withholding', appliesTo: 'purchase' },
  ],
  cities: [
    'Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Quetta',
    'Hyderabad', 'Gujranwala', 'Sialkot', 'Sukkur', 'Bahawalpur', 'Sargodha', 'Abbottabad', 'Gwadar',
  ],
  provinces: ['Sindh', 'Punjab', 'Khyber Pakhtunkhwa', 'Balochistan', 'Islamabad Capital Territory', 'Gilgit-Baltistan', 'Azad Kashmir'],
  banks: [
    'HBL', 'UBL', 'MCB Bank', 'Allied Bank', 'Bank Alfalah', 'Meezan Bank', 'Standard Chartered Pakistan',
    'Faysal Bank', 'Bank Al Habib', 'National Bank of Pakistan', 'Askari Bank', 'JS Bank',
  ],
  paymentMethods: ['cash', 'bank_transfer', 'cheque', 'raast', 'jazzcash', 'easypaisa', 'card'],
};

export const LOCALIZATION_PACKS: Record<string, LocalizationPack> = { PK: PAKISTAN };

export function localizationFor(countryCode: string | null | undefined): LocalizationPack {
  return LOCALIZATION_PACKS[(countryCode ?? 'PK').toUpperCase()] ?? PAKISTAN;
}
