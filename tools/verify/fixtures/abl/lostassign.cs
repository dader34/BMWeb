using System;
using BMW.Rheingold.Module.ISTA;

namespace BMW.Rheingold.Module.ISTA
{
	public class ABL_FIX_LOSTASSIGN : ISTAModule
	{
		public bool EcuErrorMessage;

		private void Start()
		{
			((ISTAModule)this).LastCallingMethod = "Start";
			((ISTAModule)this).__StartStep();
			Fehlerspeicher_Lesen_01_s();
		}

		private void Fehlerspeicher_Lesen_01_s()
		{
			int num3 = default(int);
			object iSTAResultAsType2 = default(object);
			while (true)
			{
				int num = 0;
				((ISTAModule)this).LastCallingMethod = "Fehlerspeicher_Lesen_01_s";
				((ISTAModule)this).__StartStep();
				num3 = 0;
				ConfigurationContainer val = null;
				val = ConfigurationContainer.Deserialize("<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<ConfigurationContainer xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" Name=\"DSCConfig\" MajorVersion=\"1\" MinorVersion=\"0\">\r\n  <Header>\r\n    <Adapter Name=\"BMW-EDIABAS-Adapter\" />\r\n  </Header>\r\n  <Body>\r\n    <Configuration Name=\"EDIABAS_SpExtract\" Origin=\"\" InternalNodeIdGenerator=\"268396\">\r\n      <Run xsi:type=\"SingleChoice\" Name=\"Run\">\r\n        <Children>\r\n          <Node xsi:type=\"SingleChoice\" Name=\"Group\">\r\n            <Children>\r\n              <Node xsi:type=\"SingleChoice\" Name=\"D_0012\">\r\n                <Children>\r\n                  <Node xsi:type=\"SingleChoice\" Name=\"Status\">\r\n                    <Children>\r\n                      <Node xsi:type=\"Executable\" Name=\"FS_LESEN\" Comment=\"\">\r\n                        <Children>\r\n                          <Node xsi:type=\"All\" Name=\"Argument\">\r\n                            <Children>\r\n                              <Node xsi:type=\"Value\" Name=\"ECUGroupOrVariant\">\r\n                                <Literal>\r\n                                  <Text />\r\n                                </Literal>\r\n                              </Node>\r\n                            </Children>\r\n                          </Node>\r\n                        </Children>\r\n                        <Result xsi:type=\"All\" Name=\"Result\">\r\n                          <Children>\r\n                            <Node xsi:type=\"SingleChoice\" Name=\"Status\">\r\n                              <Children>\r\n                                <Node xsi:type=\"Value\" Name=\"SAETZE\" Comment=\"\">\r\n                                  <Literal>\r\n                                    <Text>0</Text>\r\n                                  </Literal>\r\n                                </Node>\r\n                              </Children>\r\n                            </Node>\r\n                          </Children>\r\n                        </Result>\r\n                      </Node>\r\n                    </Children>\r\n                  </Node>\r\n                </Children>\r\n              </Node>\r\n            </Children>\r\n          </Node>\r\n        </Children>\r\n      </Run>\r\n    </Configuration>\r\n  </Body>\r\n</ConfigurationContainer>");
				IDiagnosticDeviceResult val2 = null;
				ParameterContainer val3 = new ParameterContainer();
				ParameterContainer val4 = new ParameterContainer();
				ParameterContainer val5 = new ParameterContainer();
				val3.setParameter("/WurzelIn/DSCConfig", (object)val);
				IServiceDialog val6 = ((ISTAModule)this).Factory.CreateServiceDialog((ISTAModule)(object)this, "Fehlerspeicher_Lesen_01_s", "51939083", base._globalTabModuleISTA, 131, val3, val5);
				val6.Invoke("InitializeDialog", val3, val4, val5);
				val2 = (IDiagnosticDeviceResult)val4.getParameter("/WurzelOut/DSCResult");
				int num2 = 60;
				while (true)
				{
					switch (num2)
					{
					case 60:
						iSTAResultAsType2 = val2.getISTAResultAsType("/Result/Status/SAETZE", typeof(int));
						num2 = 16;
						continue;
					case 16:
						if (iSTAResultAsType2 != null)
						{
							num2 = 6;
							continue;
						}
						goto case 0;
					case 6:
						num = (int)iSTAResultAsType2;
						num2 = 3;
						continue;
					case 3:
						num3 = num;
						num2 = 0;
						continue;
					case 0:
						if (num3 != 0)
						{
							num2 = 7;
							continue;
						}
						num2 = 9;
						continue;
					case 7:
						Mit_Fehler_05_s();
						return;
					case 9:
						Ohne_Fehler_04_s();
						return;
					}
					break;
				}
			}
		}

		private void Ohne_Fehler_04_s()
		{
			((ISTAModule)this).LastCallingMethod = "Ohne_Fehler_04_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}

		private void Mit_Fehler_05_s()
		{
			((ISTAModule)this).LastCallingMethod = "Mit_Fehler_05_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}
	}
}
