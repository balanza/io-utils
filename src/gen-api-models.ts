// tslint:disable:no-console

import * as fs from "fs-extra";
import { ITuple2, Tuple2 } from "italia-ts-commons/lib/tuples";
import * as nunjucks from "nunjucks";
import { OpenAPI, OpenAPIV2 } from "openapi-types";
import * as prettier from "prettier";
import * as SwaggerParser from "swagger-parser";

const SUPPORTED_SPEC_METHODS = ["get", "post", "put", "delete"];

function renderAsync(
  env: nunjucks.Environment,
  definition: OpenAPIV2.DefinitionsObject,
  definitionName: string,
  strictInterfaces: boolean
): Promise<string> {
  return new Promise((accept, reject) => {
    env.render(
      "model.ts.njk",
      {
        definition,
        definitionName,
        strictInterfaces
      },
      (err, res) => {
        if (err) {
          return reject(err);
        }
        accept(res);
      }
    );
  });
}

export async function renderDefinitionCode(
  env: nunjucks.Environment,
  definitionName: string,
  definition: OpenAPIV2.DefinitionsObject,
  strictInterfaces: boolean
): Promise<string> {
  const code = await renderAsync(
    env,
    definition,
    definitionName,
    strictInterfaces
  );
  const prettifiedCode = prettier.format(code, {
    parser: "typescript"
  });
  return prettifiedCode;
}

function capitalize(s: string): string {
  return `${s[0].toUpperCase()}${s.slice(1)}`;
}

function uncapitalize(s: string): string {
  return `${s[0].toLowerCase()}${s.slice(1)}`;
}

function typeFromRef(
  s: string
): ITuple2<"definition" | "parameter" | "other", string> | undefined {
  const parts = s.split("/");
  if (parts && parts.length === 3) {
    const refType: "definition" | "parameter" | "other" =
      parts[1] === "definitions"
        ? "definition"
        : parts[1] === "parameters"
        ? "parameter"
        : "other";
    return Tuple2(refType, parts[2]);
  }
  return undefined;
}

function specTypeToTs(t: string): string {
  switch (t) {
    case "integer":
      return "number";
    case "file":
      return "{ uri: string, name: string, type: string }";
    default:
      return t;
  }
}

function getDecoderForResponse(status: string, type: string): string {
  switch (type) {
    case "undefined":
      return `r.constantResponseDecoder<undefined, ${status}>(${status}, undefined)`;
    case "Error":
      return `r.basicErrorResponseDecoder<${status}>(${status})`;
    default:
      return `r.ioResponseDecoder<${status}, (typeof ${type})["_A"], (typeof ${type})["_O"]>(${status}, ${type})`;
  }
}

export function renderOperation(
  method: string,
  operationId: string,
  operation: OpenAPIV2.OperationObject,
  specParameters: OpenAPIV2.ParametersDefinitionsObject | undefined,
  securityDefinitions: OpenAPIV2.SecurityDefinitionsObject | undefined,
  extraHeaders: ReadonlyArray<string>,
  extraParameters: { [key: string]: string },
  defaultSuccessType: string,
  defaultErrorType: string,
  generateResponseDecoders: boolean
): ITuple2<string, ReadonlySet<string>> {
  const requestType = `r.I${capitalize(method)}ApiRequestType`;
  const params: { [key: string]: string } = {};
  const importedTypes = new Set<string>();
  if (operation.parameters !== undefined) {
    const parameters = operation.parameters.map(
      p => p as OpenAPIV2.ParameterObject
    );
    parameters.forEach(param => {
      if (param.name && param.type) {
        // The parameter description is inline
        const isRequired = param.required === true;
        params[`${param.name}${isRequired ? "" : "?"}`] = specTypeToTs(
          param.type
        );
        return;
      }
      // Paratemer is declared as ref, we need to look it up
      const refInParam: string | undefined =
        param.$ref || (param.schema ? param.schema.$ref : undefined);
      if (refInParam === undefined) {
        console.warn(
          `Skipping param without ref in operation [${operationId}] [${
            param.name
          }]`
        );
        return;
      }
      const parsedRef = typeFromRef(refInParam);
      if (parsedRef === undefined) {
        console.warn(`Cannot extract type from ref [${refInParam}]`);
        return;
      }
      const refType = parsedRef.e1;
      if (refType === "other") {
        console.warn(`Unrecognized ref type [${refInParam}]`);
        return;
      }

      const paramType: string | undefined =
        refType === "definition"
          ? parsedRef.e2
          : specParameters
          ? specTypeToTs(specParameters[parsedRef.e2].type)
          : undefined;

      if (paramType === undefined) {
        console.warn(`Cannot resolve parameter ${parsedRef.e2}`);
        return;
      }

      const isParamRequired =
        refType === "definition"
          ? param.required === true
          : specParameters
          ? specParameters[parsedRef.e2].required
          : false;

      const paramName = `${uncapitalize(parsedRef.e2)}${
        isParamRequired ? "" : "?"
      }`;

      params[paramName] = paramType;
      if (refType === "definition") {
        importedTypes.add(parsedRef.e2);
      }
    });
  }

  const authHeadersAndParams = operation.security
    ? getAuthHeaders(
        securityDefinitions,
        operation.security
          .map((_: OpenAPIV2.SecurityRequirementObject) => Object.keys(_)[0])
          .filter(_ => _ !== undefined)
      )
    : [];

  const authParams: { [k: string]: string } = {};
  authHeadersAndParams.forEach(_ => (authParams[_.e1] = "string"));

  const allParams = { ...extraParameters, ...authParams, ...params };

  const paramsCode = Object.keys(allParams)
    .map(paramKey => `readonly ${paramKey}: ${allParams[paramKey]}`)
    .join(",");

  const contentTypeHeaders =
    (method === "post" || method === "put") && Object.keys(params).length > 0
      ? ["Content-Type"]
      : [];

  const authHeaders = authHeadersAndParams.map(_ => _.e2);

  const headers = [...contentTypeHeaders, ...authHeaders, ...extraHeaders];

  const headersCode =
    headers.length > 0 ? headers.map(_ => `"${_}"`).join("|") : "never";

  const responses = Object.keys(operation.responses).map(responseStatus => {
    const response = operation.responses[responseStatus];
    const typeRef = response.schema ? response.schema.$ref : undefined;
    const parsedRef = typeRef ? typeFromRef(typeRef) : undefined;
    if (parsedRef !== undefined) {
      importedTypes.add(parsedRef.e2);
    }
    const responseType = parsedRef
      ? parsedRef.e2
      : responseStatus === "200"
      ? defaultSuccessType
      : defaultErrorType;
    return Tuple2(responseStatus, responseType);
  });

  const responsesType = responses
    .map(r => `r.IResponseType<${r.e1}, ${r.e2}>`)
    .join("|");

  // use the first 2xx type as "success type" that we allow to be overridden
  const successType = responses.find(_ => _.e1.length === 3 && _.e1[0] === "2");

  const responsesDecoderCode =
    generateResponseDecoders && successType !== undefined
      ? `
        // Decodes the success response with a custom success type
        export function ${operationId}Decoder<A, O>(type: t.Type<A, O>) { return ` +
        responses.reduce((acc, r) => {
          const d = getDecoderForResponse(
            r.e1,
            successType !== undefined && r.e1 === successType.e1 ? "type" : r.e2
          );
          return acc === "" ? d : `r.composeResponseDecoders(${acc}, ${d})`;
        }, "") +
        `; }

        // Decodes the success response with the type defined in the specs
        export const ${operationId}DefaultDecoder = () => ${operationId}Decoder(${
          successType.e2 === "undefined" ? "t.undefined" : successType.e2
        });`
      : "";

  const code =
    `
    /****************************************************************
     * ${operationId}
     */

    // Request type definition
    export type ${capitalize(
      operationId
    )}T = ${requestType}<{${paramsCode}}, ${headersCode}, never, ${responsesType}>;
  ` + responsesDecoderCode;

  return Tuple2(code, importedTypes);
}

function getAuthHeaders(
  securityDefinitions: OpenAPIV2.Document["securityDefinitions"],
  securityKeys: ReadonlyArray<string>
): ReadonlyArray<ITuple2<string, string>> {
  if (securityKeys === undefined && securityDefinitions === undefined) {
    return [];
  }

  const securityDefs =
    securityKeys !== undefined && securityDefinitions !== undefined
      ? // If we have both security and securityDefinitions defined, we extract
        // security items mapped to their securityDefinitions definitions.
        securityKeys.map(k => Tuple2(k, securityDefinitions[k]))
      : securityDefinitions !== undefined
      ? Object.keys(securityDefinitions).map(k =>
          Tuple2(k, securityDefinitions[k])
        )
      : [];

  return securityDefs
    .filter(_ => _.e2 !== undefined)
    .filter(_ => (_.e2 as OpenAPIV2.SecuritySchemeApiKey).in === "header")
    .map(_ => Tuple2(_.e1, (_.e2 as OpenAPIV2.SecuritySchemeApiKey).name));
}

export function isOpenAPIV2(
  specs: OpenAPI.Document
): specs is OpenAPIV2.Document {
  return specs.hasOwnProperty("swagger");
}

export async function generateApi(
  env: nunjucks.Environment,
  specFilePath: string | OpenAPIV2.Document,
  definitionsDirPath: string,
  tsSpecFilePath: string | undefined,
  strictInterfaces: boolean,
  generateRequestTypes: boolean,
  defaultSuccessType: string,
  defaultErrorType: string,
  generateResponseDecoders: boolean
): Promise<void> {
  const api = await SwaggerParser.bundle(specFilePath);

  if (!isOpenAPIV2(api)) {
    throw new Error("The specification is not of type swagger 2");
  }
  const specCode = `
    /* tslint:disable:object-literal-sort-keys */
    /* tslint:disable:no-duplicate-string */

    // DO NOT EDIT
    // auto-generated by generated_model.ts from ${specFilePath}

    export const specs = ${JSON.stringify(api)};
  `;
  if (tsSpecFilePath) {
    console.log(`Writing TS Specs to ${tsSpecFilePath}`);
    await fs.writeFile(
      tsSpecFilePath,
      prettier.format(specCode, {
        parser: "typescript"
      })
    );
  }

  const definitions = api.definitions;
  if (!definitions) {
    console.log("No definitions found, skipping generation of model code.");
    return;
  }

  for (const definitionName in definitions) {
    if (definitions.hasOwnProperty(definitionName)) {
      const definition = definitions[definitionName];
      const outPath = `${definitionsDirPath}/${definitionName}.ts`;
      console.log(`${definitionName} -> ${outPath}`);
      const code = await renderDefinitionCode(
        env,
        definitionName,
        definition,
        strictInterfaces
      );
      await fs.writeFile(outPath, code);
    }
  }

  if (generateRequestTypes || generateResponseDecoders) {
    // map global auth headers only if global security is defined
    const globalAuthHeaders = api.security
      ? getAuthHeaders(api.securityDefinitions, api.security
          .map((_: {}) =>
            Object.keys(_).length > 0 ? Object.keys(_)[0] : undefined
          )
          .filter(_ => _ !== undefined) as ReadonlyArray<string>)
      : [];

    const operationsTypes = Object.keys(api.paths).map(path => {
      const pathSpec = api.paths[path];
      const extraParameters: { [key: string]: string } = {};
      if (pathSpec.parameters !== undefined) {
        pathSpec.parameters.forEach(
          (param: {
            name: string;
            required: boolean;
            type: string | undefined;
          }) => {
            const paramType = param.type;
            if (paramType) {
              const paramName = `${param.name}${
                param.required === true ? "" : "?"
              }`;
              extraParameters[paramName] = specTypeToTs(paramType);
            }
          }
        );
      }
      // add global auth parameters to extraParameters
      globalAuthHeaders.forEach(_ => (extraParameters[_.e1] = "string"));

      return Object.keys(pathSpec).map(operationKey => {
        const method = operationKey.toLowerCase();

        if (SUPPORTED_SPEC_METHODS.indexOf(method) < 0) {
          // skip unsupported spec methods
          return;
        }
        const operation =
          method === "get"
            ? pathSpec.get
            : method === "post"
            ? pathSpec.post
            : method === "put"
            ? pathSpec.put
            : method === "head"
            ? pathSpec.head
            : method === "delete"
            ? pathSpec.delete
            : undefined;
        if (operation === undefined) {
          console.warn(`Skipping unsupported method [${method}]`);
          return;
        }
        const operationId = operation.operationId;
        if (operationId === undefined) {
          console.warn(`Skipping method with missing operationId [${method}]`);
          return;
        }

        return renderOperation(
          method,
          operationId,
          operation,
          api.parameters,
          api.securityDefinitions,
          globalAuthHeaders.map(_ => _.e2),
          extraParameters,
          defaultSuccessType,
          defaultErrorType,
          generateResponseDecoders
        );
      });
    });

    const operationsImports = new Set<string>();
    const operationTypesCode = operationsTypes
      .map(ops =>
        ops
          .map(op => {
            if (op === undefined) {
              return;
            }
            op.e2.forEach((i: string) => operationsImports.add(i));
            return op.e1;
          })
          .join("\n")
      )
      .join("\n");

    const operationsCode = `
      // DO NOT EDIT THIS FILE
      // This file has been generated by gen-api-models
      // tslint:disable:max-union-size
      // tslint:disable:no-identical-functions

      ${generateResponseDecoders ? 'import * as t from "io-ts";' : ""}

      import * as r from "italia-ts-commons/lib/requests";

      ${Array.from(operationsImports.values())
        .map(i => `import { ${i} } from "./${i}";`)
        .join("\n\n")}

      ${operationTypesCode}
    `;

    const prettifiedOperationsCode = prettier.format(operationsCode, {
      parser: "typescript"
    });

    const requestTypesPath = `${definitionsDirPath}/requestTypes.ts`;

    console.log(`Generating request types -> ${requestTypesPath}`);
    await fs.writeFile(requestTypesPath, prettifiedOperationsCode);
  }
}

//
// Configure nunjucks
//

export function initNunJucksEnvironment(): nunjucks.Environment {
  nunjucks.configure({
    trimBlocks: true
  });
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(`${__dirname}/../templates`)
  );

  env.addFilter("contains", <T>(a: ReadonlyArray<T>, item: T) => {
    return a.indexOf(item) !== -1;
  });
  env.addFilter("startsWith", <T>(a: string, item: string) => {
    return a.indexOf(item) === 0;
  });
  env.addFilter("capitalizeFirst", (item: string) => {
    return `${item[0].toUpperCase()}${item.slice(1)}`;
  });

  env.addFilter("comment", (item: string) => {
    return "/**\n * " + item.split("\n").join("\n * ") + "\n */";
  });

  env.addFilter("camelCase", (item: string) => {
    return item.replace(/(\_\w)/g, (m: string) => {
      return m[1].toUpperCase();
    });
  });

  let imports: { [key: string]: true } = {};
  env.addFilter("resetImports", (item: string) => {
    imports = {};
  });
  env.addFilter("addImport", (item: string) => {
    imports[item] = true;
  });
  env.addFilter("getImports", (item: string) => {
    return Object.keys(imports).join("\n");
  });

  let typeAliases: { [key: string]: true } = {};
  env.addFilter("resetTypeAliases", (item: string) => {
    typeAliases = {};
  });
  env.addFilter("addTypeAlias", (item: string) => {
    typeAliases[item] = true;
  });
  env.addFilter("getTypeAliases", (item: string) => {
    return Object.keys(typeAliases).join("\n");
  });

  return env;
}
