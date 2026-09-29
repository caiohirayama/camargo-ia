// Validação de CPF/CNPJ pelos dígitos verificadores, feita no servidor antes
// de aceitar os dados de cadastro vindos da IA — o modelo pode transcrever
// errado um número ditado ou digitado pelo cliente.
function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isCpfValido(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;

  const digito = (base) => {
    const soma = [...base].reduce((total, d, i) => total + Number(d) * (base.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return digito(cpf.slice(0, 9)) === Number(cpf[9]) && digito(cpf.slice(0, 10)) === Number(cpf[10]);
}

function isCnpjValido(value) {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;

  const digito = (base) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = [...base].reduce((total, d, i) => total + Number(d) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  return digito(cnpj.slice(0, 12)) === Number(cnpj[12]) && digito(cnpj.slice(0, 13)) === Number(cnpj[13]);
}

// Mesmo formato em que os cadastros existentes no GestãoClick guardam o
// documento (ex: "221.464.818-62", "51.146.335/0001-53").
function formatarCpf(value) {
  return onlyDigits(value).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
}

function formatarCnpj(value) {
  return onlyDigits(value).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

module.exports = {
  onlyDigits,
  isCpfValido,
  isCnpjValido,
  formatarCpf,
  formatarCnpj,
};
