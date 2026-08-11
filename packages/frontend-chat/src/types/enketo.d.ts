declare module 'enketo-core' {
  export class Form {
    constructor(formEl: HTMLFormElement, data: {
      modelStr: string;
      instanceStr?: string | null;
      submitted?: boolean;
      external?: Array<{ id: string; xml: XMLDocument }>;
    }, options?: {
      language?: string;
      printRelevantOnly?: boolean;
    });
    init(): string[];
    validate(): Promise<boolean>;
    getDataStr(options?: { irrelevant?: boolean }): string;
    resetView(): HTMLElement;
    languages: string[];
    currentLanguage: string;
    view: { html: HTMLElement };
    model: any;
  }
}

declare module 'enketo-transformer/web' {
  export function transform(survey: {
    xform: string;
    markdown?: boolean;
    media?: Record<string, string>;
    theme?: string;
  }): Promise<{
    form: string;
    model: string;
    languageMap: Record<string, string>;
    transformerVersion: string;
  }>;
}
