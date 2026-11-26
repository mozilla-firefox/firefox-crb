package:
	$(call py_action,package_configured,--mode=package --ab-cd=$(AB_CD))

upload:
	$(PACKAGE_UPLOAD)
