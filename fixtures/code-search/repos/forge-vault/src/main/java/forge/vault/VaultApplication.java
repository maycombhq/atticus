package forge.vault;

import forge.platform.web.ForgeServiceBase;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
@ForgeServiceBase("/vault-api")
public class VaultApplication {
  public static void main(String[] args) {
    ForgeRuntime.start(VaultApplication.class, args);
  }
}
