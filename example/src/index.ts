import { generateApi } from '@pagopa/io-utils';

generateApi({
    specFilePath: '../api.yaml',
    definitionsDirPath: `${__dirname}/generated`,
    strictInterfaces: true,
    generateRequestTypes: true,
    generateResponseDecoders: true,
    generateClient: true,
    defaultSuccessType: 'undefined',
    defaultErrorType: 'Error'
})
.then(() => console.log('generation completed'))
.catch((reason: any) => console.error('generation error', reason));
