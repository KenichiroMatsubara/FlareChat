# Bound attachment intake size

Attachment intake initially permits at most 20 MiB for one attachment and 40 MiB in aggregate for one Source Message. An Organization may configure smaller values but cannot exceed the deployment maxima.

If either limit is exceeded, Mail Automation withholds the affected Source Message from automatic event delivery and creates an Automation Exception. It does not silently omit an oversized file and publish a possibly misleading event. The limits bound Worker memory and CPU exposure as well as downstream model inputs.
