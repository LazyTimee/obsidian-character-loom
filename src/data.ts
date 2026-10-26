import defaults from "./default-tables.json";

export type Gender = string;
export type Choice = {
  value: string;
  weight: number;
  children?: Choice[];
  pairedValue?: string;
  subtableName?: string;
  gender?: Gender;
};

export type Tables = Record<string, Choice[]>;
export const genderFields = ["name", "surname", "gender-age"];

export const fieldLabels: Record<string, string> = {
  gender: "Пол",
  name: "Имя",
  surname: "Фамилия",
  race: "Раса",
  occupation: "Род деятельности",
  mood: "Настрой",
  quirk: "Странность",
  "gender-age": "Возраст",
  height: "Рост",
  build: "Фигура",
  "hair-length": "Длина волос",
  "hair-type": "Вид волос",
  "eyes-kind": "Форма глаз",
  "eyes-form": "Вид глаз",
  "eyes-color": "Цвет глаз",
  "appearance-feature": "Особенность внешности",
  clothing: "Одежда",
  "backstory-title": "Предыстория"
};

export const fieldOrder = Object.keys(fieldLabels).filter(key => key !== "gender");
export const rerollLabels: Record<string, string> = {
  "Пол": "Другой пол",
  "Имя": "Другое имя",
  "Фамилия": "Другая фамилия",
  "Имя и фамилия": "Другие имя и фамилия",
  "Раса": "Другая раса",
  "Род деятельности": "Другой род деятельности",
  "Настрой": "Другой настрой",
  "Странность": "Другая странность",
  "Возраст": "Другой возраст",
  "Рост": "Другой рост",
  "Фигура": "Другая фигура",
  "Длина волос": "Другая длина волос",
  "Вид волос": "Другой вид волос",
  "Форма глаз": "Другая форма глаз",
  "Вид глаз": "Другой вид глаз",
  "Цвет глаз": "Другой цвет глаз",
  "Особенность внешности": "Другая особенность внешности",
  "Одежда": "Другая одежда",
  "Предыстория": "Другая предыстория",
  "Внешность": "Другая внешность",
  "всё": "Другой персонаж"
};
export const valueOrder = ["name", "surname", "gender", ...fieldOrder.filter(key => key !== "name" && key !== "surname")];

function initializeWeights(items: Choice[]): void {
  if (items.length && items.every(item => item.weight === 0)) items.forEach(item => item.weight = 1);
  items.forEach(item => { if (item.children) initializeWeights(item.children); });
}
export const defaultTables: Tables = defaults;
Object.values(defaultTables).forEach(initializeWeights);
export const defaultGenders: Choice[] = defaultTables.gender;
