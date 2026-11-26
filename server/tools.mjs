import {z} from 'zod/v4';
const slice={releaseId:z.string(),day:z.number().int().nonnegative().optional(),segment:z.enum(['all','new','returning']).optional(),metric:z.number().int().min(0).max(4).optional(),version:z.string().optional()};
const event=z.enum(['checkout','invoice','payment','due','renewal']);
export const operations={
  get_release:['Описание, аудитория и главный вопрос релиза.',{releaseId:z.string()}],
  compare_metric:['Сравнить метрику до/после. Индексы 0 конверсия, 1 оплата счетов, 2 сумма оплат, 3 средний чек, 4 продления.',slice],
  breakdown:['Сравнить все, новые и постоянные компании. Возвращает числители и знаменатели.',slice],
  funnel:['Посчитать последовательные этапы оформления, выставления счёта и оплаты.',slice],
  get_calculation:['Открыть сохранённый расчёт с исходным срезом.',{id:z.string()}],
  build_chart:['Новая метрика по дням. Для длительности укажите start и end. Для рублей end=payment. Для количества stat=count.',
    {...slice,spec:z.object({title:z.string().max(100),field:z.enum(['duration','amount','events']),stat:z.enum(['median','mean','p90','sum','count']),start:event.nullable().optional(),end:event})}]
};
