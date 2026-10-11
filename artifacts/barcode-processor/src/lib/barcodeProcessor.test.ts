import { describe, expect, it } from "vitest";
import { processInput } from "./barcodeProcessor";

const CODE = "ABCDEFGHIJK";

describe("processInput", () => {
  describe("formatos aceitos", () => {
    it("processa código e quantidade separados por ponto e vírgula", () => {
      expect(processInput(`${CODE};12`)).toMatchObject({
        activeCode: CODE,
        total: 12,
      });
    });

    it("processa código e quantidade em linhas separadas", () => {
      expect(processInput(`${CODE}\n7`)).toMatchObject({
        activeCode: CODE,
        total: 7,
      });
    });

    it("processa código longo com ruído e quantidade no final", () => {
      expect(processInput(`${CODE}scanner7`)).toMatchObject({
        activeCode: CODE,
        total: 7,
      });
    });

    it("aceita quantidade com zeros à esquerda e converte para número", () => {
      expect(processInput(`${CODE};0007`)).toMatchObject({
        activeCode: CODE,
        total: 7,
      });
    });

    it("processa o formato CODE.noise.QTY", () => {
      expect(processInput(`${CODE}.noise.4`)).toMatchObject({
        activeCode: CODE,
        total: 4,
      });
    });

    it("usa a última parte como quantidade quando há ponto e múltiplos ruídos", () => {
      expect(processInput(`${CODE}.noise.extra.6`)).toMatchObject({
        activeCode: CODE,
        total: 6,
      });
    });

    it("remove prefixos não alfanuméricos antes de processar a linha", () => {
      expect(processInput(`@@-${CODE};3`)).toMatchObject({
        activeCode: CODE,
        total: 3,
      });
    });

    it("aceita códigos com letras minúsculas", () => {
      const lowercaseCode = CODE.toLowerCase();

      expect(processInput(`${lowercaseCode};2`)).toMatchObject({
        activeCode: lowercaseCode,
        total: 2,
      });
    });

    it("aceita partes extras após a quantidade no formato ponto e vírgula", () => {
      expect(processInput(`${CODE};5;ignored`)).toMatchObject({
        activeCode: CODE,
        total: 5,
      });
    });

    it("mantém o código de exceção e soma sua quantidade", () => {
      expect(processInput("624-087J\n3")).toMatchObject({
        activeCode: "624-087J",
        total: 3,
      });
    });
  });

  describe("códigos concatenados com 18 caracteres", () => {
    it("usa os últimos cinco caracteres como quantidade no formato de 18 caracteres", () => {
      expect(processInput("blctp7x00340004000")).toMatchObject({
        activeCode: "blctp7x0034",
        total: 4000,
      });
    });

    it("converte zeros à esquerda no sufixo de cinco dígitos", () => {
      expect(processInput("ABCDEFGHIJKxx04000")).toMatchObject({
        activeCode: "ABCDEFGHIJK",
        total: 4000,
      });
    });

    it("aceita a quantidade 00001 como o número 1", () => {
      expect(processInput("ABCDEFGHIJKxx00001")).toMatchObject({
        activeCode: "ABCDEFGHIJK",
        total: 1,
      });
    });

    it("adiciona a quantidade ao código ativo quando o código concatenado é diferente", () => {
      const result = processInput("0CK106CK56A\nblctp7x00340004000");

      expect(result).toMatchObject({ activeCode: "0CK106CK56A", total: 4000 });
      expect(result.logs[1]).toContain(
        '[CODIGO+RUIDO] Codigo="0CK106CK56A" Quantidade=4000',
      );
    });

    it("acumula a leitura de 18 caracteres ao total já contado do código ativo", () => {
      expect(processInput("0CK106CK56A;5\nblctp7x00340004000")).toMatchObject({
        activeCode: "0CK106CK56A",
        total: 4005,
      });
    });

    it("associa ao código ativo a quantidade mesmo com outro prefixo válido", () => {
      expect(processInput("0CK106CK56A;5\nKLMNOPQRSTUxx00007")).toMatchObject({
        activeCode: "0CK106CK56A",
        total: 12,
      });
    });

    it("interpreta zeros à esquerda na quantidade de 18 caracteres para o código ativo", () => {
      expect(processInput("0CK106CK56A\nblctp7x00340000001")).toMatchObject({
        activeCode: "0CK106CK56A",
        total: 1,
      });
    });

    it("rejeita quantidade zero no sufixo de cinco dígitos", () => {
      const result = processInput("0CK106CK56A;5\nblctp7x00340000000");

      expect(result).toMatchObject({ activeCode: "0CK106CK56A", total: 5 });
      expect(result.logs[1]).toContain("Erro: entrada invalida");
    });

    it("rejeita o formato de 18 caracteres quando o sufixo de cinco caracteres não é numérico", () => {
      const result = processInput("ABCDEFGHIJKxx12a45");

      expect(result).toMatchObject({ activeCode: null, total: 0 });
      expect(result.logs[0]).toContain("Erro: entrada invalida");
    });

    it("mantém o código e o total ativos quando o sufixo de 18 caracteres é inválido", () => {
      const result = processInput("0CK106CK56A;5\nABCDEFGHIJKxx12a45");

      expect(result).toMatchObject({ activeCode: "0CK106CK56A", total: 5 });
      expect(result.logs[1]).toContain("Erro: entrada invalida");
    });

    it("preserva a extração legada para uma entrada de 17 caracteres", () => {
      expect(processInput("ABCDEFGHIJKxx0007")).toMatchObject({
        activeCode: "ABCDEFGHIJK",
        total: 7,
      });
    });

    it("preserva a extração legada para uma entrada de 19 caracteres", () => {
      expect(processInput("ABCDEFGHIJKxxx00007")).toMatchObject({
        activeCode: "ABCDEFGHIJK",
        total: 7,
      });
    });

    it("soma a quantidade extraída à leitura já registrada para o mesmo código", () => {
      const result = processInput("blctp7x0034;3\nblctp7x00340004000");

      expect(result).toMatchObject({ activeCode: "blctp7x0034", total: 4003 });
      expect(result.logs[1]).toContain('[CODIGO+RUIDO] Codigo="blctp7x0034" Quantidade=4000');
    });

    it("não substitui o código ativo quando uma leitura de 18 caracteres soma sua quantidade", () => {
      const result = processInput("0CK106CK56A;5\nblctp7x00340004000");

      expect(result.activeCode).toBe("0CK106CK56A");
      expect(result.logs[1]).not.toContain('Codigo="blctp7x0034"');
    });

    it("produz o mesmo resultado ao reprocessar repetidamente as mesmas entradas", () => {
      const input = "0CK106CK56A;5\nblctp7x00340004000";

      expect(processInput(input)).toEqual(processInput(input));
    });
  });

  describe("regras de estado e bordas", () => {
    it("soma várias quantidades para o código ativo", () => {
      expect(processInput(`${CODE};2\n3\n${CODE}.noise.4`)).toMatchObject({
        activeCode: CODE,
        total: 9,
      });
    });

    it("ignora código diferente depois que um código ativo foi definido", () => {
      const result = processInput(`${CODE};2\nKLMNOPQRSTU;9`);

      expect(result).toMatchObject({ activeCode: CODE, total: 2 });
      expect(result.logs).toContain(
        `Linha 2: Erro: codigo diferente ignorado ("KLMNOPQRSTU" != "${CODE}")`,
      );
    });

    it("rejeita quantidade antes de existir um código ativo", () => {
      const result = processInput("5");

      expect(result).toMatchObject({ activeCode: null, total: 0 });
      expect(result.logs).toContain("Linha 1: Erro: codigo nao definido");
    });

    it("rejeita código longo sem quantidade numérica no final", () => {
      const result = processInput(`${CODE}scanner`);

      expect(result).toMatchObject({ activeCode: null, total: 0 });
      expect(result.logs[0]).toContain("entrada invalida");
    });
  });

  describe("entradas rejeitadas", () => {
    it("ignora entrada vazia sem registrar erro", () => {
      expect(processInput("")).toEqual({ activeCode: null, total: 0, logs: [] });
    });

    it.each(["abc", `${CODE};`, `${CODE}.noise.`, `${CODE};2.5`])(
      "rejeita entrada inválida %j",
      (input) => {
        const result = processInput(input);

        expect(result.total).toBe(0);
        expect(result.logs.some((log) => log.includes("entrada invalida"))).toBe(
          true,
        );
      },
    );

    it.each(["0", "000", "-1", "1.5", "abc"])(
      "rejeita quantidade inválida %j",
      (quantity) => {
        const result = processInput(`${CODE};${quantity}`);

        expect(result.activeCode).toBeNull();
        expect(result.total).toBe(0);
        expect(result.logs[0]).toContain("entrada invalida");
      },
    );

    it.each(["ABCDEFGHIJ", "ABCDEFGHIJKL", "ABC-DEF-GHI", "1234567890!"])(
      "rejeita código inválido %j",
      (code) => {
        const result = processInput(`${code};2`);

        expect(result.activeCode).toBeNull();
        expect(result.total).toBe(0);
        expect(result.logs[0]).toContain("entrada invalida");
      },
    );

    it("rejeita quantidade concatenada zero, inclusive com zeros à esquerda", () => {
      const result = processInput(`${CODE}scanner000`);

      expect(result).toMatchObject({ activeCode: null, total: 0 });
      expect(result.logs[0]).toContain("entrada invalida");
    });
  });

  describe("comportamento controverso preservado", () => {
    it("remove um P inicial antes de aplicar o parser", () => {
      expect(processInput(`P${CODE};2`)).toMatchObject({
        activeCode: CODE,
        total: 2,
      });
    });

    it("rejeita um código válido que começa com P porque o P inicial é removido", () => {
      const codeStartingWithP = "PABCDEFGHIJ";
      const result = processInput(`${codeStartingWithP};2`);

      expect(result).toMatchObject({ activeCode: null, total: 0 });
      expect(result.logs[0]).toContain("entrada invalida");
    });
  });
});
