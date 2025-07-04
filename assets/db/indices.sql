--Asignar secuencia de indices según el último
SELECT setval(
  pg_get_serial_sequence('mes_sensor_data', 'sensor_data_id'),
  (SELECT MAX(sensor_data_id) FROM mes_sensor_data)
);

--Consultar la secuencia actual de inidices de la tabla
SELECT last_value FROM mes_sensor_data_sensor_data_id_seq;
