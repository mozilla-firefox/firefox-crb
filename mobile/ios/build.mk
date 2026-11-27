ifdef MOZ_LEGACY_PACKAGING
package:
	$(MAKE) -C mobile/ios/installer

upload:
	$(MAKE) -C mobile/ios/installer upload
else
package:
	$(call py_action,package_configured,--mode=package --ab-cd=$(AB_CD))

upload:
	$(PACKAGE_UPLOAD)
endif
