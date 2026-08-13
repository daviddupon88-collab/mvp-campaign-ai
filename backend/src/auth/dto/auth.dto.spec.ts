import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateLanguageDto, SUPPORTED_LOCALES } from './auth.dto';

// Miroir de SUPPORTED_LOCALES côté frontend — la validation ici est la seule barrière
// avant écriture en base (cf. AuthService.updateLanguage), donc doit rejeter tout ce qui
// n'est pas exactement une des 4 langues supportées.
describe('UpdateLanguageDto', () => {
  it.each(SUPPORTED_LOCALES)('accepts the supported locale "%s"', async (locale) => {
    const dto = plainToInstance(UpdateLanguageDto, { preferredLanguage: locale });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it.each(['es', 'it', 'EN', '', 'en-US', "en'; DROP TABLE users; --", '<script>alert(1)</script>'])(
    'rejects an unsupported/malicious value "%s"',
    async (value) => {
      const dto = plainToInstance(UpdateLanguageDto, { preferredLanguage: value });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it('rejects a missing preferredLanguage', async () => {
    const dto = plainToInstance(UpdateLanguageDto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
