-- _assettocategory  ->  _assetTocategory  (2 pasos para evitar choque en Windows)
RENAME TABLE `stl_hub`.`_assettocategory` TO `stl_hub`.`__tmp_assettocategory`;
RENAME TABLE `stl_hub`.`__tmp_assettocategory` TO `stl_hub`.`_assetTocategory`;

-- _assettotag  ->  _assetTotag  (2 pasos)
RENAME TABLE `stl_hub`.`_assettotag` TO `stl_hub`.`__tmp_assettotag`;
RENAME TABLE `stl_hub`.`__tmp_assettotag` TO `stl_hub`.`_assetTotag`;